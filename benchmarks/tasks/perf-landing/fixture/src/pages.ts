// Server-rendered HTML for the landing page and search page.
export function renderLanding(featured: { id: number; name: string; priceCents: number }[]): string {
    const items = featured
        .map(
            (p) =>
                `<li class="product"><span>${escapeHtml(p.name)}</span><span>$${(p.priceCents / 100).toFixed(2)}</span></li>`
        )
        .join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corner Store</title>
<link rel="stylesheet" href="/static/styles.css">
<script src="/static/vendor.js"></script>
</head>
<body>
<header class="site-header">
  <div class="brand">Corner Store</div>
  <nav><a href="/">Home</a><a href="/search">Search</a></nav>
</header>
<main>
  <img src="/static/hero.png" alt="Fresh finds every week" class="hero">
  <h1>Everything for the home, delivered fast.</h1>
  <p>Kitchen, garden, office, and more &mdash; picked by your neighbors.</p>
  <section class="featured">
    <h2>Featured this week</h2>
    <ul>
${items}
    </ul>
  </section>
</main>
<footer>&copy; Corner Store</footer>
</body>
</html>
`;
}

export function escapeHtml(s: string): string {
    return s
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
