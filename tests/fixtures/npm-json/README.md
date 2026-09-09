Captured read-only on 2026-09-09 using Node22.23.2, npm10.9.8 and npm12.0.2:

- `npm pack --ignore-scripts --json --pack-destination <temporary directory>`
- `npm view ctscout-mcp-server@0.6.1 gitHead --json`

No publishing. JSON whitespace follows repository formatting; values are unchanged.
Pack metadata was captured before this script-only compatibility change;
tests use its real npm output shape, not its archive checksum as a current build assertion.
