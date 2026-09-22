---
name: page-load-basics
description: "Use when perf-audit flags a high LCP, layout shift (CLS), render-blocking resources, a large image, or missing compression/cache headers on a server-rendered HTML page."
---

# Fixing what actually delays paint

## The LCP element is usually the biggest image or block of text above the fold

If `perf-audit` names an `<img>` as the LCP element and it is also the
biggest resource: resize it to the display size (do not ship a 4000px image
into a 800px slot), re-encode (JPEG quality ~75-80, or WebP), and set
explicit dimensions or `aspect-ratio` so the browser reserves space before it
loads:

```html
<img src="/cover.jpg" width="800" height="450" style="aspect-ratio:16/9" alt="...">
```

`loading="lazy"` on the LCP image makes LCP *worse* (it delays the fetch);
never lazy-load anything visible on first paint.

## Render-blocking resources in `<head>`

A synchronous `<script src>` in `<head>` blocks parsing until it downloads
and runs. Defer it or move it to just before `</body>`:

```html
<script src="/app.js" defer></script>
```

Don't ship a whole utility library for one function; inline the one function
you use instead of importing the package.

## Fonts

A blocking `@font-face` stylesheet with no `font-display` causes invisible
text until the font loads (FOIT). Add `font-display: swap` so text renders
in a fallback font immediately, or preload the font file:

```css
@font-face { font-family: 'X'; src: url('/x.woff2'); font-display: swap; }
```

```html
<link rel="preload" href="/x.woff2" as="font" type="font/woff2" crossorigin>
```

## Compression and cache headers

Static responses with neither cost every byte on every request. In a plain
HTTP server:

```js
import { gzipSync } from 'node:zlib';
const body = gzipSync(fileBytes);
return new Response(body, {
    headers: {
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': contentType,
    },
});
```

Only set `immutable`/a long `max-age` on assets with a content-derived or
versioned path; do not cache HTML that changes per request.

## Layout shift (CLS)

Almost always: an image, ad slot, or web font with no reserved space.
Reserve space (`width`/`height`, `aspect-ratio`, or a min-height container)
for anything that loads after first paint.
