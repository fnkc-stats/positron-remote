# Available in every task (checks/tasks/*.R).
#   check(condition, what)    stop the task if a condition does not hold
#   near(x, target, tol)      |x - target| <= tol, for checking that a model recovers the simulated effect
#   record(name, value)       keep a number (estimate, p-value, table cell) in the task's JSON result, so results
#                             of two images can be compared
#   work                      a fresh directory for the task's files
#   task_file(name)           path of a file next to the tasks (for example a .qmd)
#   patients(n), visits(n)    synthetic data sets with known effects (below)

recorded <- list()

check <- function(condition, what) {
  if (!isTRUE(all(condition))) stop("check failed: ", what, call. = FALSE)
  invisible(TRUE)
}

near <- function(x, target, tol) isTRUE(abs(x - target) <= tol)

record <- function(name, value) {
  value <- unname(as.numeric(value))
  if (length(value) != 1 || is.na(value)) stop("record(): '", name, "' must be one number, got ", deparse(value), call. = FALSE)
  recorded[[name]] <<- value
  invisible(value)
}

task_file <- function(name) file.path("/checks", "tasks", name)

# One row per patient, from several sites. True effects of treatment:
#   y (continuous) +3; event (binary) odds ratio exp(0.8); score (ordinal 1-5) shift 0.7 on the latent scale;
#   visits_count rate ratio 0.7 (overdispersed); time to event hazard ratio 0.6, competing event type 2.
# About 5% of bmi and smoker are missing.
patients <- function(n = 600, seed = 20261117) {
  set.seed(seed, kind = "Mersenne-Twister", normal.kind = "Inversion", sample.kind = "Rejection")
  site <- factor(sample(sprintf("site_%02d", 1:8), n, replace = TRUE))
  site_effect <- setNames(rnorm(8, 0, 2), levels(site))[as.character(site)]
  group <- factor(sample(c("control", "treatment"), n, replace = TRUE), levels = c("control", "treatment"))
  treat <- as.integer(group == "treatment")
  age <- round(runif(n, 25, 80))
  sex <- factor(sample(c("female", "male"), n, replace = TRUE))
  bmi <- round(rnorm(n, 27, 4), 1)
  smoker <- factor(sample(c("no", "yes"), n, replace = TRUE, prob = c(0.7, 0.3)))
  y <- 50 + 3 * treat + 0.2 * age + 0.5 * (bmi - 27) + site_effect + rnorm(n, 0, 4)
  event <- rbinom(n, 1, plogis(-1 + 0.8 * treat + 0.02 * (age - 50)))
  latent <- 0.7 * treat + 0.03 * (age - 50) + rlogis(n)
  score <- factor(cut(latent, c(-Inf, -1.5, -0.5, 0.5, 1.5, Inf), labels = FALSE), levels = 1:5, ordered = TRUE)
  visits_count <- rnbinom(n, mu = exp(1.5 + log(0.7) * treat), size = 2)
  t_event <- rexp(n, 0.10 * 0.6^treat)
  t_compete <- rexp(n, 0.04)
  t_censor <- runif(n, 2, 15)
  time <- pmin(t_event, t_compete, t_censor)
  status <- ifelse(time == t_censor, 0L, ifelse(time == t_event, 1L, 2L))
  enrolled <- as.Date("2024-01-01") + sample(0:364, n, replace = TRUE)
  bmi[sample(n, n * 0.05)] <- NA
  smoker[sample(n, n * 0.05)] <- NA
  data.frame(id = sprintf("P%04d", seq_len(n)), site, group, age, sex, bmi, smoker, y, event, score,
             visits_count, time = round(time, 3), status, enrolled, stringsAsFactors = FALSE)
}

# Repeated measurements: 4 visits per patient, random intercept and slope per patient.
# True effects: slope over visits +1.5 per visit, extra +0.8 per visit with treatment.
visits <- function(n = 150, seed = 20261118) {
  set.seed(seed, kind = "Mersenne-Twister", normal.kind = "Inversion", sample.kind = "Rejection")
  id <- sprintf("P%04d", seq_len(n))
  group <- factor(sample(c("control", "treatment"), n, replace = TRUE), levels = c("control", "treatment"))
  b0 <- rnorm(n, 0, 3)
  b1 <- rnorm(n, 0, 0.5)
  d <- expand.grid(visit = 0:3, i = seq_len(n))
  d$id <- factor(id[d$i])
  d$group <- group[d$i]
  d$value <- 20 + b0[d$i] + (1.5 + b1[d$i] + 0.8 * (d$group == "treatment")) * d$visit + rnorm(nrow(d), 0, 1.5)
  d$i <- NULL
  d
}
