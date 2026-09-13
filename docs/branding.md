# r3q brand assets

The request arrow travels right in cyan; the response travels left in lime. The rounded tile and lowercase `r3q` wordmark echo the terminal client's compact interface.

| Asset | Format | Intended use |
| --- | --- | --- |
| [logo.svg](../logo.svg) | 1200 × 400, native SVG paths | README banner on either theme |
| [logo.png](../logo.png) | 2172 × 724, RGB PNG | Raster banner on either theme |
| [favicon.svg](../favicon.svg) | 256 × 256, native SVG paths | Scalable icon, including small sizes |
| [favicon.png](../favicon.png) | 1254 × 1254, RGBA PNG | Transparent raster icon master |

Palette: navy `#101820`, cyan `#39D5E8`, lime `#C6F36B`, pale wordmark `#EAF4F8`. The banner adds a `#081119` panel so the wordmark stays readable on GitHub's light and dark themes.

## Provenance

Created on 2026-09-13 with Codex's built-in `image_gen` tool, in response to the maintainer's request for generated brand art. The final PNGs are unmodified copies of generated outputs. The logo uses a dark backdrop and the favicon retains its alpha channel. SVG companions were authored as actual paths and rounded rectangles to reproduce the same identity; they contain no embedded bitmap, external font, or external resource.

The logo was refined with a wordmark cleanup edit and a solid-background edit. The favicon was generated separately using the initial lockup as a reference, followed by a background-extraction edit to replace the generator's drawn checkerboard with actual transparency. Unselected transparency experiments were discarded.

## Final prompt set

### Logo generation

```text
Use case: logo-brand
Asset type: horizontal logo.png for the r3q open-source terminal REST client and its GitHub README.
Primary request: create a beautiful, exceptionally crisp, minimal vector-style logo. Exact text "r3q" (lowercase r, numeral 3, lowercase q), with a distinctive compact request/response symbol to its left. The symbol is a dark navy rounded square containing two separate bold horizontal arrows: the upper cyan arrow points right, the lower lime arrow points left. Arrows are simple open chevrons with straight stems, equal thick rounded strokes. Use ample negative space so the symbol works as a tiny favicon. The wordmark is bold geometrically rounded monospace-inspired lowercase lettering in pale icy white, with an unmistakable 3 and q tail.
Color palette: navy #101820 tile; cyan #39D5E8 upper arrow; lime #C6F36B lower arrow; wordmark #EAF4F8.
Composition: wide horizontal lockup centered on a genuinely transparent canvas, approximately 3:1 aspect ratio, generous but not excessive outer margin. The symbol and wordmark have balanced height. Flat solid colors only.
Constraints: transparent background with real alpha outside the tile and text. Exactly one icon and one wordmark. No slogan, no extra text, no mockup, no gradients, no shadow, no bevel, no glow, no texture, no watermark. Clean boundaries suitable for reproducing with simple SVG geometry.
```

### Logo wordmark cleanup

```text
Use case: precise-object-edit
Asset type: logo.png for r3q.
Input image 1: edit target, the r3q logo with cyan/lime request-response tile and pale lowercase r3q wordmark.
Primary request: clean up only the wordmark edges and stray pixels. The pale r3q letters must have exceptionally smooth geometric vector-style boundaries, uniform solid pale color #EAF4F8, and no stray bright pixels, ragged outlines, scratches, holes, grain or speckles around or inside the letters. Keep the exact readable lettering r3q, letter shapes, positions, size, spacing and overall layout. Keep the icon unchanged. Preserve the existing genuine alpha transparency outside the artwork. No drawn checkerboard background, no solid background, no shadow, no extra text, no other changes.
```

### Logo banner background

```text
Use case: precise-object-edit
Asset type: logo.png, a dark README banner for r3q.
Input image 1: edit target, the approved navy request/response tile with cyan right arrow, lime left arrow and pale lowercase r3q wordmark.
Replace the ENTIRE gray checkerboard background with one uniform solid opaque dark navy color #081119. Fill the background between and inside the letters with the exact same #081119. This is an opaque banner, no transparency. Keep the existing smooth logo shapes, colors, positions, scale and proportions exactly unchanged. Keep exact lowercase r, numeral 3, lowercase q lettering: r3q. Clean flat vector-style image. No checkerboard, no grain, no stray pixels, no speckles, no texture, no gradient, no glow, no shadow, no additional text or shapes. Keep wide 3:1 landscape composition.
```

### Favicon generation (logo as reference)

```text
Use case: logo-brand
Asset type: favicon.png, a square app icon for the r3q terminal REST client.
Input image 1: reference image for the approved r3q request/response logo.
Primary request: produce ONLY the icon from the reference, centered and large on a square transparent canvas. Remove the complete r3q wordmark. Keep the same dark navy rounded square with exactly two bold arrows inside: cyan upper arrow pointing right and lime lower arrow pointing left. Equal thick rounded strokes, simple horizontal stems and chevrons, generous separation. Match the reference identity and colors.
Color palette: tile #101820, upper arrow #39D5E8, lower arrow #C6F36B. Flat solid colors.
Composition: the rounded square occupies 88 percent of the square canvas; fully transparent outer margin and transparent corners outside the tile. The icon must read at 16px.
Constraints: genuine alpha transparency, no text or lettering, no extra objects, no gradients, no shadow, no bevel, no glow, no texture, no border, no watermark. Crisp vector-style edges.
```

### Favicon transparency edit

```text
Use case: background-extraction
Asset type: favicon.png for r3q.
Input image 1: edit target, the approved navy tile with cyan right arrow above a lime left arrow.
Change only the background outside the navy rounded-square tile: remove all gray checkerboard pixels entirely and produce a true transparent alpha channel outside the tile. This must be an RGBA PNG with fully transparent outer corners, not a drawn checkerboard or solid-color canvas. Keep the navy tile and its two arrows exactly unchanged, in the same position, size, geometry and colors. Keep square aspect ratio. No lettering, no extra shapes, no shadow, no new background.
```

## Validation

The favicon PNG has real transparent and opaque pixels; the logo PNG is intentionally opaque. Both SVGs parse as XML and render without embedded images or external dependencies. The README banner was visually checked against light and dark backgrounds, and the favicon at 16, 32, and 64 pixels.
