# R packages

Every R package a project uses is in its environment image. A container never downloads or builds packages, and a host needs no package repository. A project therefore works the same whatever the host's network allows, including no outside network at all (see [Images on hosts without registry access](#images-on-hosts-without-registry-access)).

## Where packages come from

1. **The team image `r-env`** ([env/Dockerfile](../env/Dockerfile), [env/renv.lock](../env/renv.lock)). The packages are installed into `/usr/local/lib/R/site-library` when the image is built, in CI with network access. They are the same in every container made from that digest and read-only for the `analyst` user.
2. **A derived image `r-env-<name>`** (optional), for projects that need packages `r-env` lacks: a published `r-env` digest plus the packages of `env/derived/<name>/extra.lock`. See [Derived images](#derived-images).

A project selects one of them by digest in `container.json`:

```json
{ "image": "ghcr.io/fnkc-stats/r-env@sha256:<digest>" }
```

Changing packages means a new image: change `env/renv.lock` (all projects, eventually) or a derived image's `extra.lock` (projects that pin it), let CI build and check it, then move projects to the new digest with a reviewed change of `container.json`, one at a time. Old digests stay usable until no project pins them.

**Which one?** A package the team uses in several projects, or one that a common task needs, goes into `r-env`. A package that one project needs, a heavy toolchain (Stan, spatial libraries), or an experiment goes into a derived image. A derived image costs one more image on each host, but changes nothing for the other projects.

## Changing the team image r-env

On a computer with Docker and network (not on the server):

1. **Add the packages** to `env/renv.lock`:

   ```bash
   env/add-packages.sh Hmisc rms
   ```

   The script runs the image pinned in [project-template/container.json](../project-template/container.json), which must have been built from the current `env/renv.lock` (otherwise pass the image that was, with `--image`). It installs the packages from that image's CRAN snapshot, adds them and the dependencies the image lacks, and writes renv's own records for them. Versions already in `renv.lock` never change: if a new package needs a newer version of one of them, the script stops and names it, and the package has to wait for a snapshot update (step 1b).

   1b. **Snapshot update** (newer R or newer versions of the existing packages): change `R_VERSION` and the Rocker base digest in [env/Dockerfile](../env/Dockerfile), regenerate `renv.lock` with all its packages at the versions of a newer snapshot, and set `CRAN_SNAPSHOT` to the date `env/snapshot-date.sh` reports for that lockfile. There is no script for the regeneration yet: install the package names of the current `renv.lock` in the new Rocker image from the new snapshot and record them with `renv::snapshot()`. A snapshot update changes results more often than an addition: compare the `values` of the [R environment checks](../checks/README.md) between the old and new image.
2. **Cover the new packages in the checks**: extend a task in [checks/tasks/](../checks/tasks) or add one, on synthetic data with a known result ([checks/README.md](../checks/README.md#adding-a-task)).
3. **Optionally build and check locally** (for this computer's architecture):

   ```bash
   docker build -t r-env:candidate env
   checks/run.sh r-env:candidate
   ```

4. **Open a pull request.** The [env image workflow](../.github/workflows/env-image.yml) builds the image natively for amd64 and arm64, checks every locked version with `verify.R`, renders a synthetic Quarto report, runs the R environment checks and the SSH tests, all without network and as the analyst user. Someone else reviews the lockfile change.
5. **Merge to `main`.** The workflow publishes the tested image under a unique tag and a multi-architecture index; the run summary shows the line to pin: `ghcr.io/fnkc-stats/r-env@sha256:...`.
6. **Pin the new digest**: first in `project-template/container.json` (new projects, and the default image for `add-packages.sh` and `checks/run.sh`), then in each project's `container.json`, one reviewed commit per project. Analysts stop and reopen the project. Optionally send the image to each host before the first analyst needs it ([next-steps](next-steps.md#deployment-acceptance)). Derived images move to the new `r-env` by changing their `base` ([Derived images](#derived-images)).

Hosts allow image repositories, not digests (`allowedImages`): a new `r-env` digest needs no change on the server.

## Derived images

A derived image only **adds** packages to a published `r-env`; it never changes a version `r-env` has. Every image built from the same `r-env` digest therefore has the team's packages at the same versions, and the R environment checks of `r-env` still hold for them.

- `env/derived/<name>/base`: one line, the `r-env` digest it is built on (`repository@sha256:...`).
- `env/derived/<name>/extra.lock`: the added packages and those of their dependencies the base lacks, with exact versions (renv lockfile format).
- [env/derived/Dockerfile](../env/derived/Dockerfile) installs them with renv from the base image's own repository setting (its CRAN snapshot), so they are built for the same R and system libraries. [verify.R](../env/verify.R) checks every version of both lockfiles and fails if `extra.lock` changes a version of the base.

To create or extend one, on a computer with Docker and network (not on the server):

```bash
env/derived/lock.sh survey-tools mice naniar   # writes env/derived/survey-tools/extra.lock (and base, if new)
```

`lock.sh` keeps packages already in `extra.lock`, skips packages the base already has, and records only what it had to add. Commit both files. The [derived images workflow](../.github/workflows/derived-image.yml) builds each derived image for the architectures its base has, verifies it, runs the [R environment checks](../checks/README.md) and the SSH tests, and on `main` publishes `ghcr.io/fnkc-stats/r-env-<name>` with the digest to pin in the run summary. Add that exact repository to the hosts' `allowedImages`.

To move a derived image to a new `r-env`, put the new digest into `base` and run `lock.sh <name>` again, so the added packages come from the new snapshot. A package that the new `r-env` has itself drops out of `extra.lock`.

## Where packages are downloaded from

Packages are downloaded only while an image is built (in CI, or on a maintainer's computer for a local build, `add-packages.sh` and `lock.sh`), never on a host or in a project container.

- **Source: a dated CRAN snapshot** of Posit Package Manager (PPM), `https://packagemanager.posit.co/cran/__linux__/<distro>/<CRAN_SNAPSHOT>`, for example `.../noble/2025-08-30`. A snapshot is frozen: the same date always serves the same versions. For the image's Ubuntu release it serves binary packages, so the build compiles little; a locked version that is no longer current on that date is built from source with the image's compilers and `-dev` libraries.
- **One snapshot per image.** `CRAN_SNAPSHOT` in [env/Dockerfile](../env/Dockerfile) is the date `env/snapshot-date.sh` chooses for `renv.lock`: the first day by which every locked version was on CRAN. The image keeps it as the label `r-env.cran-snapshot` and as `options(repos)` in `Rprofile.site`. `add-packages.sh` and derived images read it from there, so every added package comes from the same snapshot as the image's own packages.
- **The repository URL in `renv.lock` is not used.** The build replaces it with the snapshot (`RENV_CONFIG_REPOS_OVERRIDE`). The versions in the lockfile decide what is installed; the snapshot only decides where they are downloaded from.
- **CRAN only.** Packages from Bioconductor, GitHub or other repositories are not supported by the image builds yet. Adding them needs a reviewed change of the Dockerfiles: a pinned Bioconductor release, or a GitHub package at an exact commit.
- **No other sources.** No `install.packages()` from a live CRAN mirror, no `remotes::install_github()` and no packages copied in by hand: a package that is not in a lockfile is not in an image.

Hosts and containers have no package repository. `options(repos)` in a container still names the image's snapshot, but a host without outside network cannot reach it, and a package installed there would not be in the image anyway ([Rules for analysts](#rules-for-analysts)).

## renv

renv is a build tool here, not a project tool.

- **In the image build**: `renv::restore()` installs the packages of `env/renv.lock` (and of a derived image's `extra.lock`) into the image's site library, with renv's cache and sandbox off. The lockfiles are the record of what an image contains. Change them with `env/add-packages.sh` or `env/derived/lock.sh`, which write renv's own records, rather than by hand.
- **In the image**: the lockfiles stay in `/usr/local/share/r-env/`, with checksums and `installed-packages.json` (every installed package, R version, platform, system libraries). `verify.R` checks at build time that the installed versions are exactly the locked ones.
- **In projects**: renv is not activated. Do not run `renv::init()` or keep `source("renv/activate.R")` in a project's `.Rprofile`: a project library starts empty, and it cannot be filled in a container without network, so R would not find the image's packages. The digest in `container.json` is the project's package record: it fixes R, every package version and the system libraries. A project may keep a `renv.lock` from another setup as a note, but it is not restored; the image's versions are the ones that run.
- **renv's cache** is not used, on hosts or in containers.

## Images on hosts without registry access

Hosts do not need to reach the registry. When the pinned image is missing on a host, Open downloads it on the user's computer by its digest (registry HTTP API, no Docker needed there), keeps it in the client's cache, and sends it through the gateway. The host checks every manifest and layer against the pinned digest and the host's architecture before `docker load`. The digest fixes the content, not its publisher, so digest changes in `container.json` are reviewed like code (see [operations](operations.md#environment-images)). It is sent once per host and digest; later Opens use the host's copy. Details: [operations](operations.md#environment-images).

## Checking that packages fit together

A partial update can break packages that were left behind, even when everything installs. [checks/](../checks/README.md) checks an image's packages against each other and runs the team's common tasks on synthetic data. CI runs them for every image it builds; run `checks/run.sh <image>` by hand for any other image.

## Rules for analysts

- Packages come only from the image. `install.packages()` in a container installs into the home directory, which is lost when the container is recreated, and does not work at all on a host without network. Ask for the package to be added to `env/renv.lock` or to a derived image instead.
- Do not rely on a personal library (`~/R/...`).
- Do not activate renv in a project ([renv](#renv)). The image digest in `container.json` already records every package version.
- After changing the image digest in `container.json`, stop and reopen the project.

## Local containers

Local runs (host `local`, Colima, Docker Desktop or WSL) use the same images. The local Docker pulls a missing image itself (`pullImages` is on for `local`); if that fails, the same download-and-load path is used. The image must match the computer's architecture: an Apple silicon Mac needs an arm64 (or multi-architecture) digest in `container.json`.
