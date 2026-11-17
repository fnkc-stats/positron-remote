// The R environment checks (checks/ at the repository root), embedded like the container scripts, so that
// build-library can run them on a host before it marks a library ready. A unit test checks that every file
// in checks/tasks and checks/lib is listed here.
import check from '../../checks/check.R';
import helpers from '../../checks/lib/helpers.R';
import packages from '../../checks/lib/packages.R';
import task from '../../checks/lib/task.R';
import io from '../../checks/tasks/io.R';
import missing from '../../checks/tasks/missing.R';
import models from '../../checks/tasks/models.R';
import plots from '../../checks/tasks/plots.R';
import report from '../../checks/tasks/report.R';
import reportQmd from '../../checks/tasks/report.qmd';
import survival from '../../checks/tasks/survival.R';
import tables from '../../checks/tasks/tables.R';
import wrangle from '../../checks/tasks/wrangle.R';

/** Paths under /checks in the container, and their contents. */
export const CHECK_FILES: Record<string, string> = {
  'check.R': check,
  'lib/helpers.R': helpers, 'lib/packages.R': packages, 'lib/task.R': task,
  'tasks/io.R': io, 'tasks/missing.R': missing, 'tasks/models.R': models, 'tasks/plots.R': plots,
  'tasks/report.R': report, 'tasks/report.qmd': reportQmd, 'tasks/survival.R': survival,
  'tasks/tables.R': tables, 'tasks/wrangle.R': wrangle,
};
