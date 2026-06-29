# Mobile assets

These are referenced by `app.config.ts` and must exist before an EAS build.
They are intentionally NOT committed as binaries — generate them from the
`icon.svg` source so the mark stays identical to the web favicon and the
loading-screen runner.

| File | Size | Used for |
| --- | --- | --- |
| `icon.png` | 1024×1024 | App icon (iOS and Android legacy) |
| `adaptive-icon.png` | 1024×1024, safe area 66% | Android adaptive foreground |
| `splash.png` | 1284×2778 or any tall PNG | Launch screen |
| `notification-icon.png` | 96×96, white on transparent | Android notification tray |

Android tints the notification icon to a single colour, so it must be a white
silhouette on transparency — a full-colour icon renders as a white blob.

Generate them with any SVG rasteriser, for example:

```bash
npx sharp-cli -i icon.svg -o icon.png resize 1024 1024
npx sharp-cli -i icon.svg -o adaptive-icon.png resize 1024 1024
npx sharp-cli -i notification.svg -o notification-icon.png resize 96 96
```
