---
inclusion: fileMatch
fileMatchPattern: ["app/**/*.tsx", "components/**/*.tsx"]
---
# Seance UI design rules

## Mood
A candle-lit seance: dark, quiet, a little eerie. Spooky elements must help the user understand what is happening, not just decorate.

## Visual language
- Near-black background with a slight violet tint; surfaces one step lighter.
- One warm accent: candle-glow amber, for primary actions and "alive" states.
- One cold accent: spectral blue-green, for spirits (operations and tool calls).
- Headings in a serif display font (e.g. Cinzel); body in a clean sans-serif; transcripts and code in monospace.
- Generous spacing, no clutter.

## Metaphors (keep them consistent)
- Summon = import a WSDL
- Spirits = SOAP operations, rising when a service is summoned
- Commune = try an operation from the UI
- Ouija transcript = the call log: JSON in -> XML out -> XML back -> JSON out

## Motion
- Slow, drifting animations (300-800 ms), never flashy.
- Respect `prefers-reduced-motion`: replace motion with simple fades.

## Accessibility (must pass)
- WCAG AA contrast for all text.
- Every interactive element is keyboard reachable with a visible focus ring.
- Icon-only controls have aria-labels; animation never hides essential information.
- Works at phone width (360 px) with no horizontal scroll.
