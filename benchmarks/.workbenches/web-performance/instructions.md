# Make it fast

Measure before you touch anything. Run `perf-audit <url>` first, always. It
gives response time, SQL statements per request grouped by query, and for
HTML pages: LCP, CLS, total bytes, the five biggest resources, and
render-blocking resources, ending in a ranked biggest-costs list.

Work the list top down. Fix everything on it that is embarrassing, one at a
time, re-measuring after each. Two costs often hide behind one slow
endpoint (an unbounded result set AND a full scan): fixing one does not
clear the other. Skip anything that is already fine.

- Query count scaling with data size (a loop issuing one query per row) is
  almost always the dominant cost. Collapse it into one query with a JOIN or
  aggregate. Check EXPLAIN before adding an index; match the real filter.
- If the biggest resource is an image, fix the image: right dimensions, a
  real compressed format, explicit width/height so it does not shift layout.
- If a script or stylesheet is render-blocking and doesn't have to be, defer
  it or move it out of `<head>`.
- Add compression and cache headers to static responses if they are missing.
- An endpoint that returns every matching row is a bug. Bound it with a
  LIMIT and sensible paging (keyset if the table grows). A page of results
  is not a change in what the user sees; an unbounded one is a memory
  blowup waiting for data.

Caching is not a fix. It hides a slow path and lies once the cache is cold.
Don't reach for it.

If a tool prints "cannot run here" or a section says "not measured (...)",
skip it and measure that part by hand. Never try to repair the tool.

Re-run `perf-check <url>` after each change and confirm the number moved.
Stop when nothing on the list is embarrassing anymore. Measure the tail,
not just the common request: a query that returns one row or none should
be as fast as one that returns a page, and if it is not, the scan is still
there.

Keep the page's content and the API's shape the same. No rewrites, no new
frameworks, no test suites or docs nobody asked for. Smallest diff that fixes
the dominant cost, every time.
