# Only needed if the project needs packages that the shared r-env image does not have.
# Starts from a specific r-env tag and adds the project's packages; versions come from the same CRAN snapshot as r-env.
# Built by .github/workflows/project-env.yml (template in project-template/project-env.yml),
# then the resulting tag goes into container.env.
FROM ghcr.io/fnkc-stats/r-env:YYYY.MM.DD-abc1234

RUN Rscript -e 'pak::pkg_install(c("brms", "marginaleffects"), ask = FALSE); pak::cache_clean()'
