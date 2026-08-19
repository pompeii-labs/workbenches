# Governance

Workbench is stewarded by Pompeii Labs as an open standard with a reference
implementation. Before 1.0, named maintainers make project decisions in public
repository issues and pull requests.

## Decisions

- Bug fixes and implementation changes use ordinary pull requests.
- Portable behavior changes must update the specification, schemas, fixtures,
  and reference implementation together where applicable.
- A released `spec` parser is immutable. Incompatible package-format changes
  require a new spec number.
- Security-sensitive changes may be developed privately until coordinated
  disclosure is safe.
- A maintainer approval and all protected checks are required to merge.

Maintainers seek rough consensus from affected implementers and publishers.
When consensus is unavailable, the project lead makes the pre-1.0 decision and
records the reasoning publicly. This model may be replaced by broader
governance when independent implementations and sustained external
maintainership justify it.

Workbench packages remain controlled and licensed by their publishers. The
standard does not transfer package ownership to Pompeii Labs.
