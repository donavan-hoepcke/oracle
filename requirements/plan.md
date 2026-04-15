# Plan

Bot-template adaptation plan for the Oracle web stack.

## Scope
- Add a runtime bot control surface (start, stop, source switching).
- Keep existing Excel watchlist flow as a first-class source.
- Add a Playwright source for websites that require manual login before symbol reads.
- Preserve current quote, trend, and stair-step signal logic.

## Steps
- [x] Define bot runtime state and source abstraction.
- [x] Add API endpoints for bot lifecycle and source switching.
- [x] Extend websocket payloads with bot status.
- [x] Add frontend controls for source and lifecycle.
- [x] Add Playwright ticker extraction with configurable selector.
- [x] Add configurable login + post-login navigation for Playwright source.
- [x] Add preview endpoint to test DOM selectors before full source switch.
- [ ] Configure production selector and login URL for the target website.
- [ ] Validate end-to-end with real login flow and monitored symbols.

## Risks
- Page DOM changes may break selector-based ticker extraction.
- Browser automation may require session refresh if login expires.
- Symbol-only sources have no target range, so target alerts are disabled unless target values are supplied.

## Git Strategy
- Always work in a feature branch when making changes
- Branch naming: `feature/<short-description>` or `fix/<short-description>`
- **Never commit, push, or merge unless explicitly asked**
- Keep commits atomic and focused when requested

## Testing
- Start with `excel` source and verify no regressions.
- Switch to `playwright`, complete manual login in opened browser, and verify symbols load.
- Confirm websocket `botStatus` updates on start/stop/source changes.
