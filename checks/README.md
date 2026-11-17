# R environment checks

R packages do not always declare what they need. If only some of them are updated, the ones left behind can break even though every package installs and loads. These checks run the team's common work in an image and report what breaks. Run them before a new image is pinned in projects.

```sh
checks/run.sh                                   # the image in project-template/container.json
checks/run.sh ghcr.io/fnkc-stats/r-env@sha256:… # any image: a candidate, or one a project pins
checks/run.sh r-env:candidate models tables     # a local build, only some tasks
```

The checks are mounted into a throwaway container, not built into the image, so any image can be checked as it is. The container has no network and runs as the analyst user (uid 1000), like a project container. Results go to `checks/results/<date-time>/` (ignored by git), or to `--out DIR`. With Colima, Docker can only mount directories under your home. The exit status is 0 only if every step passed.

CI runs them for every image it builds ([image.yml](../.github/workflows/image.yml): `r-env` and each derived image, per architecture) before publishing it. The GitHub workflow [r-checks.yml](../.github/workflows/r-checks.yml) also runs them on every change to `checks/` or `project-template/container.json`. It can also be started by hand (Actions → r checks → Run workflow) with any image, for example a new candidate digest before it goes into `container.json`. The results are kept as the run's `r-checks` artifact.

## What is checked

**`packages`**: whether the installed packages fit together. It covers all libraries in `.libPaths()`, so in a derived image it checks the added packages together with those of `r-env`.

- Every `Depends`, `Imports` and `LinkingTo` requirement is installed in an allowed version, and so is every installed `Suggests` package. This catches a declared requirement that the installed versions don't meet.
- Compiled packages were built for this R version and platform.
- Every namespace loads without errors **or warnings**. glmmTMB, TMB and lme4 report at load time that they were built against another version of TMB or Matrix. That is the usual result of updating a package without rebuilding the packages compiled against it.
- Packages hidden by another version in an earlier library are listed. An image should have none: it shows which versions code would actually load.

**Tasks** (`tasks/*.R`): the team's common work on synthetic data with known effects (`patients()` and `visits()` in [lib/helpers.R](lib/helpers.R)). Each task checks its results, so it catches packages that load fine but no longer work together.

| Task | Covers |
|---|---|
| `io` | Excel (openxlsx, readxl), SPSS and Stata with value and variable labels (haven, labelled), CSV (readr, data.table), Cyrillic text |
| `wrangle` | dplyr, tidyr, janitor, forcats, lubridate, stringr, purrr; data.table and dtplyr agree with dplyr |
| `models` | lm/glm with broom, car, sandwich; lme4, lmerTest, glmmTMB, ordinal, mgcv; emmeans (Kenward-Roger), ggeffects |
| `survival` | Kaplan-Meier, log-rank, Cox, competing risks (tidycmprsk, cmprsk), ggsurvfit with a risk table, tbl_survfit |
| `missing` | naniar, visdat; mice imputation and pooled estimates |
| `tables` | gtsummary (tbl_summary with add_p, tbl_regression, tbl_merge, tbl_stack) through gt to HTML, Word and Excel |
| `plots` | ggplot2 with extensions, patchwork, cowplot, ragg PNGs with Cyrillic text, PDF, plotly HTML widgets, ggraph |
| `report` | Quarto to HTML and Word with a gtsummary table, a figure and inline results; R Markdown |

Every step runs in its own R process. A crash in compiled code fails that step, not the whole run. A task fails on an error. Warnings are listed in the summary and the step's JSON file but don't fail the task. The `packages` step does fail on warnings at load time.

## Results

Each step writes `<step>.json`, and the run writes `summary.json`. A task's file has its status, error and warnings, the versions of all packages it loaded, and `values`: the numbers it recorded with `record()` (estimates, p-values, degrees of freedom, table cells). When the same tasks run in two images, these values show whether a result changed, not only whether it still runs.

## Adding a task

Add `tasks/<name>.R`. It runs with the helpers from [lib/helpers.R](lib/helpers.R):

```r
d <- patients()                                  # synthetic data with known effects
fit <- lm(y ~ group + age, data = d)
b <- coef(fit)[["grouptreatment"]]
check(near(b, 3, 1), "lm recovers the treatment effect")   # stops the task if it does not hold
record("lm_treatment", b)                       # kept in the result for comparisons
```

Write files to `work`, a fresh directory for each task. Other files the task needs go next to it in `tasks/` (for example `report.qmd`) and are found with `task_file()`. Use synthetic data only: the checks run in CI and must never see project data. Code is English only (`./lint.sh`), so write non-ASCII text with escapes such as `"да"`.

The best tasks are short versions of real project code. When a project uses a package or function the tasks don't cover yet, add it here.
