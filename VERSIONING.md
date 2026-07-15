# geneWeave Versioning

geneWeave is versioned as **one product** using **Semantic Versioning** (`MAJOR.MINOR.PATCH`), with a **fabric
codename on each major**. The two editions — **community** (this repo) and **private/enterprise** — always ship
the **same version number**; the *edition* is a separate field, not part of the version.

```
<major>.<minor>.<patch>   —   majors also carry a fabric codename   (e.g. 1.0.0 "Aertex")
```

| Component | Meaning | Upgrade Center badge |
|-----------|---------|----------------------|
| **Major** | breaking change / new architecture / a non-backward-compatible data or deploy migration. Advances the fabric codename. | `major` |
| **Minor** | new features, backward-compatible. | `minor` |
| **Patch** | fixes, security, docs — always backward-compatible. | `patch` |

These meanings **are** the contract the in-app Upgrade Center enforces: `computeBumpType` maps a release onto
patch/minor/major, and the **anti-rollback** floor is a plain SemVer comparison (an older-but-signed release is
rejected as a downgrade). Keeping the product on SemVer is therefore required for the upgrade UX to be meaningful.

## Editions share the version

Community and private release the **same `x.y.z`** so an instance's Upgrade Center can line up its **edition
check** and **version compare**. The signed release manifest carries both `version` **and** `edition`; a manifest
built for another edition is refused. (An enterprise instance therefore only ever accepts enterprise releases at
the shared version line.)

## Fabric codenames (majors only)

Each **major** is named after a single-word fabric from the
[list of fabrics](https://en.wikipedia.org/wiki/List_of_fabrics), alphabetically. Minors and patches keep the
current major's codename.

| Major | Codename | | Major | Codename | | Major | Codename |
|------:|----------|---|------:|----------|---|------:|----------|
| 1 | **Aertex** | | 9 | Intarsia | | 17 | Rinzu |
| 2 | Batiste | | 10 | Jersey | | 18 | Satin |
| 3 | Calico | | 11 | Knit | | 19 | Taffeta |
| 4 | Damask | | 12 | Linen | | 20 | Ultrasuede |
| 5 | Etamine | | 13 | Muslin | | 21 | Velvet |
| 6 | Flannel | | 14 | Nankeen | | 22 | Wadmal |
| 7 | Gauze | | 15 | Organza | | 23 | Zephyr |
| 8 | Habutai | | 16 | Percale | | | |

```
1.0.0  "Aertex"   →  First GA
1.1.0  "Aertex"   →  Feature release (same fabric)
1.1.1  "Aertex"   →  Patch (same fabric)
2.0.0  "Batiste"  →  Next major (new fabric)
```

## Releases

A release is a **`v<x.y.z>` git tag** with a **GitHub Release** carrying an **Ed25519-signed `manifest.json`**
(`version`, `edition`, `layers.code.repoTag = the tag`, `fileManifestDigest`, plus schema + content layers). The
running instance trusts it only if it is signed by a key in its trust set, is for its edition, isn't expired, and
isn't a downgrade.

- **Cutting a release:** [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) → *Publisher runbook — cutting a release*.
- **Consuming a release:** [`docs/UPGRADE_ENGINE.md`](docs/UPGRADE_ENGINE.md) (and the **Upgrade Center** admin UI:
  configure the source, Check, review, merge code, one-click Upgrade).

## Current release

| Version | Codename | Editions |
|---------|----------|----------|
| **1.0.0** | Aertex | community + private (same version line) |

## Related

- The framework libraries geneWeave depends on — the `@weaveintel/*` packages — version **independently** with
  **SemVer via Changesets** (currently `0.x`), on a **separate track** from this product version. See the
  framework's `VERSIONING.md`.
