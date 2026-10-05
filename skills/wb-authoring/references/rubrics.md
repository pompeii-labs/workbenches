# Rubrics, design artifacts, and blacklists

Taste lives in three places. Write all three for any work whose quality is not fully captured by tests.

## Design artifact

A file the model writes before any implementation, with required decisions. The gate checks that it exists and that its declared states match the evidence manifest.

For an app, for example:

1. **Concept**: anchored in something physical or cultural (a field notebook, a transit departure board), not a mood word.
2. **Palette**: named tokens with values and roles.
3. **Type**: families, scale, and where each is used.
4. **Shape**: corner radii, stroke weights, density.
5. **Signature element**: the one thing a screenshot is recognized by.
6. **Iconography and voice.**
7. **States**: a table of every screen and state the work must prove.

Then a rule that code uses tokens only: no raw colors, no ad hoc sizes.

## Rubric

A rubric turns "good" into something two reviewers would score the same way.

- **Categories** follow the judging axes.
- **A scale** with a concrete description of every level in every category. "0: unstyled primitives. 1: basic object with a glow. 2: authored silhouette, trim, and state cues. 3: reads as a finished asset at a glance."
- **Calibration anchors**: reference images or examples for low and high levels. "If it reads closer to the first anchor than the third, it is a 1 no matter how much code went into it."
- **Thresholds**: "Done: every category at least 2 and the average at least 2.3."
- **Automatic failures**: patterns that fail the work regardless of score. "Fog, darkness, bloom, or particles standing in for missing geometry." "The heads-up display is a column of stat cards."
- **An anti-gaming rule**: adapt categories to the genre by naming the equivalents first; never add content just to raise a score.

## Blacklist of default taste

Generated work converges on recognizable templates. Name the ones this domain falls into, specifically enough that the model can recognize itself:

- A cream or parchment background with a terracotta accent and a serif headline: the default "tasteful" look generated apps land on.
- A centered hero, three feature cards, and a gradient button.
- Untextured primitives, empty arenas, and box skylines in a 3D scene.
- Placeholder copy, lorem ipsum, or "Replace this with your first screen".

Pair each with what to do instead, or point at the design artifact decision that prevents it.
