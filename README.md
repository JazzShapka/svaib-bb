# svaib for BB

Connect the svaib account and work with the management-space structure in BB Desktop. Requires BB 0.48.1 or later with compatible Plugin SDK 0.6.104. A Codex or Claude Code model connection and a svaib account are configured separately.

Install `https://github.com/JazzShapka/svaib-bb` in BB Settings → Installed plugins → Install from source. The package is at the repository root. BB uses its bundled npm and toolchain; users do not install npm or unpack an archive. The ordinary Git URL tracks the default branch; immutable semantic-version tags are available for explicit range tracking.

For an agent-managed install with an explicit compatible release range:

```sh
bb plugin install git:https://github.com/JazzShapka/svaib-bb.git@^0.3.0
```

The repository contains the BB plugin and explicit methodology packages for Codex and Claude Code. The connection assistant selects the actual provider, validates the bundled package and prepares a stable local marketplace, then uses that CLI's normal plugin installation. Python 3 is required by the methodology handlers and managed sign-in. The managed Codex sign-in path currently requires Codex CLI 0.166.0. User credentials remain in the normal model and svaib sign-in flows.

BB plugin updates deliver new bundled files. Updating the native methodology installation is a separate checked operation in the same profile; it is not an atomic part of the BB update. The connection assistant preserves working sign-ins and asks before replacing a marketplace from a different source.
