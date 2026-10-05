# Diagram images

PNG renders of every Mermaid diagram in the docs, made with `@mermaid-js/mermaid-cli`. The Mermaid source stays in the Markdown files; these images are for slides and the report. Regenerate them after editing a diagram.

| Image | Source |
|---|---|
| `final-system-overview.png` | [architecture-diagram.md](../architecture-diagram.md) section 1 |
| `final-data-model.png` | architecture-diagram.md section 2 |
| `final-deployment-and-delivery.png` | architecture-diagram.md section 3 (dashed parts are written, never run) |
| `02-stage2-overview.png` | [02-architecture.md](../02-architecture.md) section 1 (Stage 2 design) |
| `02-booking-sequence.png` | 02-architecture.md section 4 |
| `02-checkin-sequence.png` | 02-architecture.md section 5 |

Regenerate:

```powershell
npm install --prefix tools/mermaid @mermaid-js/mermaid-cli     # once; tools/mermaid is not committed
$env:CHROME = "$env:LOCALAPPDATA\ms-playwright\chromium-1234\chrome-win64\chrome.exe"   # optional: reuse Playwright's Chromium
node scripts/render-diagrams.mjs
```

Known cosmetic issues: in the two sequence diagrams the step-number circles sit on top of some labels; the system overview is tall because of the monitoring edges.
