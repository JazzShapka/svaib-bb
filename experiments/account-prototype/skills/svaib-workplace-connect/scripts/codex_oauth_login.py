"""Owned native OAuth receiver. No model turns, credential reads or protocol output.

The same-profile Codex app-server owns PKCE, token exchange and persistence.
Exit zero means native login completed/already available, never BB proof.
"""

import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

WAIT_SECONDS = 3600
FORM_WINDOW_SECONDS = 31 * 60
SERVER_KEYS = {"svaib", "plugin:svaib:svaib"}
PLUGIN_ID = "svaib@svaib"
RESOURCE_ORIGIN = "https://api.svaib.com"


class LoginError(RuntimeError):
    pass


class WaitExpired(LoginError):
    pass


class RenewRequested(Exception):
    pass


def command_json(argv, cwd=None):
    result = subprocess.run(argv, cwd=cwd, capture_output=True, timeout=20, check=False)
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise LoginError("Не удалось проверить выбранное рабочее место.")
    try:
        return json.loads(result.stdout)
    except (ValueError, TypeError):
        raise LoginError("Не удалось проверить выбранное рабочее место.") from None


def verify_binding(args):
    record = command_json(["bb", "thread", "show", args.thread_id, "--json"])
    thread, environment = record.get("thread", {}), record.get("environment", {})
    expected = {
        "id": args.thread_id,
        "projectId": args.project_id,
        "environmentId": args.environment_id,
        "providerId": "codex",
    }
    if (
        any(thread.get(k) != v for k, v in expected.items())
        or thread.get("deletedAt")
        or environment.get("id") != args.environment_id
        or environment.get("hostId") != args.host_id
        or environment.get("status") != "ready"
        or Path(environment.get("path", "")).resolve() != args.cwd
        or Path.cwd().resolve() != args.cwd
    ):
        raise LoginError("Рабочее место изменилось. Вход не начат.")


@contextmanager
def profile_lock(root):
    path = root / ".svaib-native-oauth.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if os.name == "nt":
            import msvcrt

            os.write(descriptor, b"0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        raise LoginError(
            "В этом профиле уже ожидается вход. Продолжи прежний терминал."
        ) from None
    finally:
        os.close(descriptor)
        # Keep the empty advisory-lock file: OS releases the lock even after a
        # crash; unlinking it would allow another process to lock a different inode.


class AppServer:
    def __init__(self, executable, cwd, config_root):
        environment = dict(os.environ, CODEX_HOME=str(config_root))
        self.process = subprocess.Popen(
            [str(executable), "app-server", "--stdio"],
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.messages = queue.Queue(maxsize=128)
        self.pending = []
        self.identifier = 0
        self.writer = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(1024 * 1024 + 1)
                if not line or len(line) > 1024 * 1024:
                    break
                message = json.loads(line)
                # No execution, approval, model or credential control requests are serviced.
                if message.get("method") and "id" in message:
                    self.send(
                        {
                            "id": message["id"],
                            "error": {"code": -32601, "message": "unsupported"},
                        }
                    )
                else:
                    self.messages.put_nowait(message)
        except (ValueError, OSError, queue.Full, LoginError):
            pass
        try:
            self.messages.put_nowait(None)
        except queue.Full:
            pass

    def send(self, value):
        try:
            with self.writer:
                self.process.stdin.write(
                    (json.dumps({"jsonrpc": "2.0", **value}) + "\n").encode()
                )
                self.process.stdin.flush()
        except (OSError, ValueError):
            raise LoginError(
                "Процесс входа завершился. Продолжи подключение в BB."
            ) from None

    def wait(self, predicate, seconds=30):
        for message in list(self.pending):
            if predicate(message):
                self.pending.remove(message)
                return message
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(
                    timeout=max(0.01, deadline - time.monotonic())
                )
            except queue.Empty:
                break
            if message is None:
                raise LoginError("Процесс входа завершился. Продолжи подключение в BB.")
            if predicate(message):
                return message
            # Ignore unrelated notifications instead of retaining auth URLs or history.
            if (
                "id" in message
                or message.get("method") == "mcpServer/oauthLogin/completed"
            ):
                if len(self.pending) >= 32:
                    break
                self.pending.append(message)
        raise WaitExpired("Ожидание входа завершилось. Продолжи подключение в BB.")

    def call(self, method, params):
        self.identifier += 1
        identifier = self.identifier
        self.send({"id": identifier, "method": method, "params": params})
        message = self.wait(lambda obj: obj.get("id") == identifier)
        if "error" in message:
            # Native error bodies can contain the full authorization URL. Never forward them.
            raise LoginError(
                "Codex не смог выполнить шаг входа. Продолжи подключение в BB."
            )
        return message.get("result", {})

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            reported = False
            while self.process.poll() is None:
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    if not reported:
                        print(
                            "Завершаю предыдущую попытку входа. Пожалуйста, подожди.",
                            flush=True,
                        )
                        reported = True
            # Never terminate/kill during native credential writes. The helper
            # and its profile lock stay owned until this process really exits.
        for stream in (self.process.stdin, self.process.stdout):
            if stream and not stream.closed:
                stream.close()


def open_browser(url):
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "auth.svaib.com"
        or parsed.path != "/oauth2/auth"
        or parsed.username
        or parsed.password
    ):
        raise LoginError("Codex вернул неожиданный адрес входа. Вход не открыт.")
    configured = os.environ.get("BROWSER", "")
    executable = (
        configured
        if configured and not any(c.isspace() for c in configured)
        else (
            "/usr/bin/open"
            if sys.platform == "darwin"
            else "rundll32.exe"
            if sys.platform == "win32"
            else "xdg-open"
        )
    )
    arguments = [executable, url]
    if executable == "rundll32.exe":
        arguments = [executable, "url.dll,FileProtocolHandler", url]
    subprocess.Popen(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def login(
    rpc,
    server_key,
    cwd,
    check_binding,
    browser=open_browser,
    plugin_id=PLUGIN_ID,
    resource_origin=RESOURCE_ORIGIN,
    wait_seconds=WAIT_SECONDS,
    requests=None,
    form_window_seconds=FORM_WINDOW_SECONDS,
):
    rpc.call(
        "initialize",
        {
            "clientInfo": {"name": "svaib-native-login", "version": "1"},
            "capabilities": {"experimentalApi": True},
        },
    )
    rpc.send({"method": "initialized"})
    # This private native thread runs no turns. It is not the user's BB runtime/proof.
    thread = rpc.call(
        "thread/start", {"cwd": str(cwd), "ephemeral": True, "approvalPolicy": "never"}
    )["thread"]
    if Path(thread.get("cwd", "")).resolve() != cwd:
        raise LoginError("Codex выбрал другое рабочее место. Вход не начат.")
    thread_id = thread["id"]
    rows = rpc.call(
        "mcpServerStatus/list",
        {"threadId": thread_id, "serverName": server_key, "detail": "toolsAndAuthOnly"},
    ).get("data", [])
    matches = [row for row in rows if row.get("name") == server_key]
    if (
        len(matches) != 1
        or matches[0].get("pluginId") != plugin_id
        or matches[0].get("httpOrigin") != resource_origin
        or matches[0].get("runtimeStatus") in {"disabled", "cancelled"}
    ):
        raise LoginError(
            "Не подтверждён сервер svaib из установленного плагина. Вход не начат."
        )
    check_binding()
    if matches[0].get("authStatus") == "oAuth":
        return  # Preserve the working native grant; BB still verifies its own fresh proof.
    if matches[0].get("authStatus") != "notLoggedIn":
        raise LoginError(
            "Состояние входа Codex не подтверждено. Подключение не изменено."
        )
    deadline = time.monotonic() + wait_seconds
    started = rpc.call(
        "mcpServer/oauth/login",
        {"name": server_key, "threadId": thread_id, "timeoutSecs": wait_seconds},
    )
    identifier = started.get("loginId")
    if not isinstance(identifier, str) or not identifier:
        raise LoginError("Codex не подтвердил идентификатор входа. Вход не открыт.")
    check_binding()
    browser(started["authorizationUrl"])
    print(
        "Подтверди вход в браузере. После перерыва нажми «Продолжить подключение» в BB; выполненные шаги сохранятся.",
        flush=True,
    )
    matches = lambda obj: (
        obj.get("method") == "mcpServer/oauthLogin/completed"
        and obj.get("params", {}).get("loginId") == identifier
    )
    while True:
        try:
            completed = rpc.wait(
                matches, seconds=min(1, max(0.01, deadline + 30 - time.monotonic()))
            ).get("params", {})
            break
        except WaitExpired:
            if time.monotonic() >= deadline + 30:
                raise
        if requests is not None:
            try:
                action = requests.get_nowait()
            except queue.Empty:
                continue
            check_binding()
            if action == "cancel":
                raise KeyboardInterrupt()
            if action == "renew" or deadline - time.monotonic() < form_window_seconds:
                raise RenewRequested()
            if action == "reopen":
                browser(started["authorizationUrl"])
    check_binding()
    if (
        completed.get("success") is not True
        or completed.get("name") != server_key
        or completed.get("threadId") != thread_id
    ):
        raise LoginError("Вход Codex не завершён. Продолжи подключение в BB.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "codex",
        "cwd",
        "config-root",
        "server-key",
        "thread-id",
        "project-id",
        "environment-id",
        "host-id",
    ):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.server_key not in SERVER_KEYS:
        raise LoginError("Неизвестный ключ сервера svaib.")
    for name in ("codex", "cwd", "config_root"):
        raw = Path(getattr(args, name))
        if not raw.is_absolute() or not raw.exists():
            raise LoginError("Нужны проверенные абсолютные пути рабочего места.")
        setattr(args, name, raw.resolve())
    configured = Path(
        os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    ).resolve()
    if configured != args.config_root:
        raise LoginError("Профиль Codex не совпал с текущим рабочим местом.")
    version = subprocess.run(
        [str(args.codex), "--version"], capture_output=True, timeout=10, check=False
    )
    if version.returncode or version.stdout.strip() != b"codex-cli 0.166.0":
        raise LoginError("Эта версия Codex ещё не проверена для управляемого входа.")
    verify_binding(args)
    with profile_lock(args.config_root):
        requests = queue.Queue(maxsize=1)

        def read_requests():
            for line in sys.stdin:
                if line.strip() in {"reopen", "renew", "cancel"}:
                    try:
                        requests.put_nowait(line.strip())
                    except queue.Full:
                        pass

        threading.Thread(target=read_requests, daemon=True).start()
        while True:
            rpc = AppServer(args.codex, args.cwd, args.config_root)
            try:
                login(
                    rpc,
                    args.server_key,
                    args.cwd,
                    lambda: verify_binding(args),
                    requests=requests,
                )
                print("Штатный вход Codex завершён. Доступ в разговоре проверит BB.")
                break
            except RenewRequested:
                print(
                    "Обновляю незавершённый вход. Уже работающий доступ останется на месте.",
                    flush=True,
                )
            finally:
                rpc.close()
            # Old native process is fully gone before inspecting its normal
            # credential status in the new process. No cache/token is read here.
            verify_binding(args)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        main()
    except Exception:  # noqa: BLE001 - process boundary must redact private protocol failures
        # Even unexpected protocol failures may include a private OAuth URL in
        # their exception text. No native body or traceback leaves the helper.
        print(
            "Вход не завершён. Вернись в BB → svaib → «Продолжить подключение». Сохранённые входы не удалены.",
            file=sys.stderr,
        )
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
