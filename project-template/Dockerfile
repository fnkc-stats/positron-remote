# Нужен, только если проекту не хватает пакетов общего образа r-env.
# Берёт конкретный тег r-env и добавляет пакеты проекта; версии — из того же снимка CRAN, что и r-env.
# Сборка: .github/workflows/project-env.yml (шаблон в project-template/project-env.yml),
# затем готовый тег записывается в container.env.
FROM ghcr.io/fnkc-stats/r-env:YYYY.MM.DD-abc1234

RUN Rscript -e 'pak::pkg_install(c("brms", "marginaleffects"), ask = FALSE); pak::cache_clean()'
