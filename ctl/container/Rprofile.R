# Loaded at the start of every R session in a project container (sourced from Rprofile.site by the entrypoint).
local({
  # When the container reaches its memory limit, the kernel stops the process with the highest score: make it
  # the R session (Positron offers to restart it) rather than Positron's own processes in the container.
  try(writeLines("1000", "/proc/self/oom_score_adj"), silent = TRUE)

  # Tell the user if the previous R session was stopped for using too much memory
  if (interactive()) {
    events <- tryCatch(readLines("/sys/fs/cgroup/memory.events", warn = FALSE), error = function(e) character())
    kills <- suppressWarnings(as.integer(sub("^oom_kill ", "", grep("^oom_kill ", events, value = TRUE))))
    seen_file <- "/tmp/.fnkc-oom-seen"
    seen <- suppressWarnings(as.integer(tryCatch(readLines(seen_file, warn = FALSE), error = function(e) "0")))
    if (length(kills) == 1 && !is.na(kills) && kills > max(0L, seen[1], na.rm = TRUE)) {
      limit <- tryCatch(readLines("/sys/fs/cgroup/memory.max", warn = FALSE), error = function(e) "max")
      gb <- if (grepl("^[0-9]+$", limit)) sprintf("%.1f GB", as.numeric(limit) / 2^30) else "its limit"
      message(
        "\nNote: the previous R session was stopped because the project used all of its memory (", gb, ").\n",
        "Load less at once (arrow, duckdb or data.table instead of whole data frames; rm() and gc() after large\n",
        "intermediate results), or ask the server admin to raise limits.memory.\n"
      )
      try(writeLines(as.character(kills), seen_file), silent = TRUE)
    }
  }
})
