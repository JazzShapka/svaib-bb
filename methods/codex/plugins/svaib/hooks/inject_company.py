#!/usr/bin/env python3
"""Native hook adapter for the shared company binding/pin contract.

Only native input and a checked own Codex session_meta header supply lifecycle.
No model tool_input field establishes cwd, native identity or parent lineage.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from company_context import (
    CompanyContextError,
    ContextView,
    Decision,
    HostEvent,
    _unique_object,
    process_event,
)
from company_context import (
    inspect_context as inspect_company_context,
)
from hook_space import claude_project_dir

TRUSTED_TOOL_PREFIXES = ("mcp__svaib__", "mcp__plugin_svaib_svaib__")
# Only the source format proven in BB native evidence is currently accepted.
CODEX_SESSION_SOURCES = frozenset({"vscode"})


def tool_operation(tool_name: object) -> str | None:
    """Only the canonical global server and bundled svaib server are trusted."""
    if isinstance(tool_name, str):
        for prefix in TRUSTED_TOOL_PREFIXES:
            if tool_name.startswith(prefix):
                return tool_name[len(prefix) :] or None
    return None


def _text(value: Any, reason: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        raise CompanyContextError(reason)
    return value


def _codex_header(raw: dict[str, Any]) -> tuple[dict[str, Any], str, str | None]:
    identifier = _text(raw.get("session_id"), "native_conversation_unknown")
    path = Path(_text(raw.get("transcript_path"), "native_lineage_unknown"))
    if not path.is_absolute():
        raise CompanyContextError("native_lineage_unknown")
    try:
        with path.open("rb") as transcript:
            first = transcript.readline(65537)
        if len(first) > 65536:
            raise CompanyContextError("native_lineage_unknown")
        header = json.loads(first, object_pairs_hook=_unique_object)
    except (OSError, UnicodeError, ValueError) as error:
        raise CompanyContextError("native_lineage_unknown") from error
    payload = header.get("payload") if isinstance(header, dict) else None
    if (
        not isinstance(header, dict)
        or header.get("type") != "session_meta"
        or not isinstance(payload, dict)
    ):
        raise CompanyContextError("native_lineage_unknown")
    source = payload.get("source")
    parent: str | None
    if isinstance(source, str) and source in CODEX_SESSION_SOURCES:
        if payload.get("id") != identifier:
            raise CompanyContextError("native_lineage_unknown")
        parent = payload.get("forked_from_id")
        if parent is not None and (
            not isinstance(parent, str) or not parent or parent == identifier
        ):
            raise CompanyContextError("native_lineage_unknown")
    else:
        # Only the one-hop child PreToolUse envelope measured in native BB is supported.
        # Raw session_id is the parent; the own transcript and agent_id identify the child.
        if raw.get("hook_event_name") != "PreToolUse" or not isinstance(source, dict):
            raise CompanyContextError("native_lineage_unknown")
        subagent = source.get("subagent")
        spawn = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
        if (
            set(source) != {"subagent"}
            or not isinstance(subagent, dict)
            or set(subagent) != {"thread_spawn"}
            or not isinstance(spawn, dict)
            or not {"depth", "parent_thread_id"} <= set(spawn)
            or not set(spawn)
            <= {
                "depth",
                "parent_thread_id",
                "agent_path",
                "agent_nickname",
                "agent_role",
            }
            or type(spawn["depth"]) is not int
            or spawn["depth"] != 1
        ):
            raise CompanyContextError("native_lineage_unknown")
        parent = _text(spawn["parent_thread_id"], "native_lineage_unknown")
        child = _text(raw.get("agent_id"), "native_lineage_unknown")
        if (
            payload.get("id") != child
            or child == parent
            or identifier != parent
            or payload.get("forked_from_id") != parent
        ):
            raise CompanyContextError("native_lineage_unknown")
        identifier = child
    cwd = Path(_text(raw.get("cwd"), "workspace_root_invalid"))
    original = Path(_text(payload.get("cwd"), "workspace_root_invalid"))
    if (
        not cwd.is_absolute()
        or not original.is_absolute()
        or cwd.resolve() != original.resolve()
    ):
        raise CompanyContextError("native_workspace_changed")
    return payload, identifier, parent


def normalize_host_event(raw: dict[str, Any], host: str = "auto") -> HostEvent:
    if not isinstance(raw, dict):
        raise CompanyContextError("native_event_invalid")
    name = _text(raw.get("hook_event_name"), "native_event_invalid")
    header: dict[str, Any] | None = None
    identifier = _text(raw.get("session_id"), "native_conversation_unknown")
    verified_parent: str | None = None
    if host in {"auto", "codex"}:
        header, identifier, verified_parent = _codex_header(raw)
        host = "codex"
    elif host != "claude":
        raise CompanyContextError("native_host_unknown")
    cwd = Path(_text(raw.get("cwd"), "workspace_root_invalid"))
    if not cwd.is_absolute():
        raise CompanyContextError("workspace_root_invalid")
    if host == "claude":
        project = claude_project_dir()
        if os.environ.get("CLAUDE_CODE_IS_COWORK") == "1" or project is None:
            raise CompanyContextError("native_workspace_unknown")
        # Native Claude cwd follows persistent Bash cd; the host project stays fixed.
        cwd = Path(project)
    child = header is not None and isinstance(header.get("source"), dict)
    if host == "claude" and (
        raw.get("agent_id") is not None or raw.get("agent_type") is not None
    ):
        if name != "PreToolUse":
            raise CompanyContextError("native_lineage_unknown")
        agent = _text(raw.get("agent_id"), "native_lineage_unknown")
        agent_type = _text(raw.get("agent_type"), "native_lineage_unknown")
        if max(len(identifier), len(agent), len(agent_type)) > 1024:
            raise CompanyContextError("native_lineage_unknown")
        verified_parent = identifier
        identifier = "subagent:" + json.dumps(
            [identifier, agent], ensure_ascii=False, separators=(",", ":")
        )
        if len(identifier) > 1024:
            raise CompanyContextError("native_lineage_unknown")
        child = True
    if (raw.get("agent_id") is not None and not child) or name in {
        "SubagentStart",
        "SubagentStop",
    }:
        raise CompanyContextError("native_lineage_unknown")
    lifecycle: str | None = None
    parent: str | None = None
    if child:
        lifecycle, parent = "subagent", verified_parent
    elif name == "SessionStart":
        source = raw.get("source")
        lifecycle = (
            source
            if source in {"startup", "resume", "compact", "clear", "fork"}
            else None
        )
        if lifecycle == "fork":
            if header is None or not header.get("forked_from_id"):
                raise CompanyContextError("native_lineage_unknown")
            parent = header["forked_from_id"]
        elif (
            lifecycle == "startup"
            and header is not None
            and header.get("forked_from_id")
        ):
            raise CompanyContextError("native_lineage_unknown")
    elif name == "PostCompact":
        name, lifecycle = "SessionStart", "compact"
    operation = tool_operation(raw.get("tool_name"))
    arguments = raw.get("tool_input")
    return HostEvent(
        host,
        identifier,
        name,
        cwd,
        lifecycle,
        parent,
        operation,
        arguments if isinstance(arguments, dict) else None,
    )


def inspect_context(raw: dict[str, Any], root: Path, host: str = "auto") -> ContextView:
    """Map observer only: no receipt/pin creation, lineage derivation or cleanup."""
    try:
        return inspect_company_context(normalize_host_event(raw, host), Path(root))
    except (CompanyContextError, OSError, TypeError, ValueError) as error:
        return ContextView(
            "blocked", reason=getattr(error, "reason", "native_event_invalid")
        )


def load_registry(path: Path | None = None) -> dict[str, str]:
    path = path or Path(__file__).with_name("company_operations.json")
    try:
        policy = json.loads(path.read_bytes(), object_pairs_hook=_unique_object)
    except (OSError, UnicodeError, ValueError) as error:
        raise CompanyContextError("company_policy_unavailable") from error
    if (
        not isinstance(policy, dict)
        or set(policy) != {"schema_version", "operations"}
        or type(policy["schema_version"]) is not int
        or policy["schema_version"] != 1
        or not isinstance(policy["operations"], dict)
    ):
        raise CompanyContextError("company_policy_unavailable")
    if any(
        not isinstance(name, str) or not name or value not in ("account", "company", "profile")
        for name, value in policy["operations"].items()
    ):
        raise CompanyContextError("company_policy_unavailable")
    return policy["operations"]


def _message(reason: str | None) -> str:
    if reason == "company_context_busy":
        return "Не удалось проверить компанию сейчас. Повторите вызов."
    if reason in {
        "workspace_binding_missing",
        "workspace_boundary_invalid",
        "invalid_platform_binding",
        "invalid_company_id",
        "workspace_root_invalid",
    }:
        return "У пространства нет корректной привязки к компании. Выполните подключение пространства."
    if reason == "company_selector_mismatch":
        return (
            "Вызов подготовлен для другой компании. "
            "Проверьте компанию пространства и начните чистый чат."
        )
    return (
        "Компания этого чата не подтверждена. Продолжите в исходном пространстве "
        "или начните новый чистый чат."
    )


def render_decision(
    decision: Decision, event_name: str, host: str
) -> dict[str, Any] | None:
    if decision.action == "pass":
        return None
    if event_name != "PreToolUse":
        return {
            "hookSpecificOutput": {
                "hookEventName": event_name,
                "additionalContext": _message(decision.reason),
            }
        }
    output: dict[str, Any] = {"hookEventName": "PreToolUse"}
    if decision.action == "deny":
        output.update(
            permissionDecision="deny",
            permissionDecisionReason=_message(decision.reason),
        )
    elif decision.action == "rewrite":
        output["updatedInput"] = decision.updated_input
        if host == "codex":
            # Codex requires allow for rewrite; native MCP approvals are a separate gate.
            output["permissionDecision"] = "allow"
        # Claude candidate deliberately does not issue allow. Native acceptance stays open.
    return {"hookSpecificOutput": output}


def handle_input(
    raw: dict[str, Any], host: str = "auto", *, registry: dict[str, str] | None = None
) -> dict[str, Any] | None:
    name = raw.get("hook_event_name")
    if name == "SessionEnd":
        return None
    operation = tool_operation(raw.get("tool_name"))
    if name == "PreToolUse":
        if operation is None:
            return None
        try:
            registry = registry if registry is not None else load_registry()
        except CompanyContextError as error:
            return render_decision(Decision("deny", reason=error.reason), name, host)
        if registry.get(operation) not in {"company", "profile"}:
            return (
                None  # ACCOUNT and unknown tools retain their exact original arguments.
            )
    elif name not in {"SessionStart", "PostCompact"}:
        return None
    try:
        event = normalize_host_event(raw, host)
        result = process_event(event, registry or {})
        return render_decision(result, str(name), event.host)
    except (CompanyContextError, OSError, TypeError, ValueError) as error:
        return render_decision(
            Decision("deny", reason=getattr(error, "reason", "native_event_invalid")),
            str(name),
            host,
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "host", nargs="?", choices=("auto", "codex", "claude"), default="auto"
    )
    options = parser.parse_args()
    try:
        raw = json.load(sys.stdin)
        if not isinstance(raw, dict):
            raise CompanyContextError("native_event_invalid")
        output = handle_input(raw, options.host)
    except (CompanyContextError, OSError, UnicodeError, ValueError, TypeError):
        output = render_decision(
            Decision("deny", reason="native_event_invalid"), "PreToolUse", options.host
        )
    if output is not None:
        print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
