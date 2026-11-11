// Submit source files to the W3C HTML Checker; no npm packages required.
// Import Node's built-in file tools. Their promises let us wait for disk operations with await.
import { readdir, readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
// Import a helper that joins folder and file names for the current operating system.
import path from 'node:path';
// Import a helper that runs a command and waits until it finishes.
import { spawnSync } from 'node:child_process';
// Import a pause function and call it delay.
import { setTimeout as delay } from 'node:timers/promises';

// W3C's HTML checker endpoint. out=json asks for results our program can read.
const endpoint = 'https://validator.w3.org/nu/?out=json';
// Use a custom report folder from the environment, or the default hidden folder.
const reportDir = process.env.W3C_REPORT_DIR || '.validation-results';

// Define a folder-search function. async means it can await file operations.
async function findHtml(directory) {
  // Start an empty list of HTML file paths.
  const files = [];
  // Read each folder entry, including whether it is a file or directory.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Combine the folder path and entry name into a usable path.
    const filename = path.join(directory, entry.name);
    // Search directories except Git data, installed packages, and generated reports.
    if (entry.isDirectory() && !['.git', 'node_modules', '.validation-results'].includes(entry.name)) {
      // Search this subfolder too. The ... adds each returned path to our list.
      files.push(...await findHtml(filename));
    // Accept files ending in .htm or .html. The i makes this case-insensitive.
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      // Add this matching file to the list.
      files.push(filename);
    // End the decision for this entry; symbolic links are not followed.
    }
  // End the loop through this folder's entries.
  }
  // Return the file paths in alphabetical order for predictable reports.
  return files.sort();
// End the folder-search function.
}

// Prepare text for GitHub's special annotation format.
function escapeAnnotation(value) {
  // Convert to text, then encode percent signs and carriage returns.
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D')
    // Encode newlines, commas, and colons so messages cannot change the annotation structure.
    .replaceAll('\n', '%0A').replaceAll(',', '%2C').replaceAll(':', '%3A');
// End the annotation-escaping function.
}

// Define a GitHub message helper; default to line 1 if no line number is available.
function annotate(level, filename, message, line = 1) {
  // Only print GitHub's special format when running inside GitHub Actions.
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Tell GitHub the severity, file, line, and message to display.
    console.log(`::${level} file=${escapeAnnotation(filename)},line=${line}::${escapeAnnotation(message)}`);
  // End the GitHub-only condition.
  }
// End the annotation function.
}

// Turn W3C's response text into a JavaScript object.
function parseResult(output) {
  // Parse JSON; malformed JSON throws an error instead of producing a false pass.
  const result = JSON.parse(output);
  // Require a messages array and inspect every item in it.
  if (!result || !Array.isArray(result.messages) || result.messages.some(message =>
    // Reject missing messages or unexpected message types.
    !message || !['info', 'error', 'non-document-error'].includes(message.type))) {
    // Stop trusting this response; the caller will record INCOMPLETE.
    throw new Error('W3C returned an unexpected response; validation was not completed.');
  // End the response-format check.
  }
  // Return the checked response to the caller.
  return result;
// End the response-reading function.
}

// Define the function that submits one HTML file to W3C.
async function validate(filename) {
  // Read the original bytes; do not repair or rewrite the HTML before checking it.
  const source = await readFile(filename);
  // Run curl, a web-request tool. Arguments are passed directly, without shell evaluation.
  const response = spawnSync('curl', [
    // Hide progress, show errors, fail on HTTP errors, and allow 45 seconds per attempt.
    '--silent', '--show-error', '--fail', '--max-time', '45',
    // Retry temporary failures at most twice, waiting 5 seconds; stop starting retries after 120 seconds.
    '--retry', '2', '--retry-delay', '5', '--retry-max-time', '120',
    // Tell W3C that the request body is HTML encoded as UTF-8.
    '-H', 'Content-Type: text/html; charset=utf-8',
    // Send unchanged bytes from standard input (@-) to W3C using an HTTP POST.
    '--data-binary', '@-', endpoint,
  // Supply the HTML as input and allow up to 10 MiB of captured output.
  ], { input: source, maxBuffer: 10 * 1024 * 1024 });
  // A command-launch failure or nonzero exit status means the request failed.
  if (response.error || response.status !== 0) {
    // Report the most useful error available. ?. handles a missing error object safely.
    throw new Error(response.error?.message || response.stderr.toString().trim() || 'W3C request failed.');
  // End the request-failure check. HTTP success alone does not mean valid HTML.
  }
  // Read the response body and parse W3C's validation messages.
  return parseResult(response.stdout.toString());
// End the one-file validation function.
}

// Use file paths given after the command, or discover HTML from the current folder (.).
const files = process.argv.length > 2 ? process.argv.slice(2) : await findHtml('.');
// Do not report success if there were no HTML files to check.
if (files.length === 0) {
  // Explain that no files were validated.
  console.error('No HTML files found; validation cannot pass without checking any files.');
  // Exit with status 1; the shell and GitHub interpret this as failure.
  process.exit(1);
// End the empty-file-list check.
}

// Create the report folder and any missing parents; an existing folder is fine.
await mkdir(reportDir, { recursive: true });
// Collect the results from all files in one list.
const reports = [];
// Remember whether any file failed or could not be checked.
let failed = false;
// Visit each filename and its position in the list.
for (const [index, filename] of files.entries()) {
  // Wait one second between files to avoid sending requests too quickly.
  if (index > 0) await delay(1000); // Keep requests sequential and gentle on the public service.
  // Handle failures for each file separately so later files still get checked.
  try {
    // Wait for this file's W3C result before processing the next file.
    const result = await validate(filename);
    // Count markup errors: these make the document invalid.
    const errors = result.messages.filter(message => message.type === 'error').length;
    // Count problems that prevented W3C from completing validation.
    const serviceErrors = result.messages.filter(message => message.type === 'non-document-error').length;
    // Count advisory warnings separately from errors.
    const warnings = result.messages.filter(message =>
      // Recognize warnings under either spelling of the subtype field.
      message.type === 'info' && (message.subType || message.subtype) === 'warning').length;
    // Choose INCOMPLETE for service errors, FAIL for markup errors, otherwise PASS.
    const status = serviceErrors ? 'INCOMPLETE' : errors ? 'FAIL' : 'PASS';
    // Keep any failure recorded; a later passing file must not erase an earlier failure.
    failed ||= status !== 'PASS';
    // Save the filename, status, counts, and full W3C response.
    reports.push({ file: filename, status, errors, warnings, result });
    // Print a short result to the local terminal or Actions log.
    console.log(`${filename}: ${status} (${errors} errors, ${warnings} warnings)`);
    // Go through the detailed messages for this file.
    for (const message of result.messages) {
      // Use W3C's positive integer line number, otherwise fall back to line 1.
      const line = Number.isInteger(message.lastLine) && message.lastLine > 0 ? message.lastLine : 1;
      // Show info messages as advisory warnings and both error types as errors.
      const level = message.type === 'info' ? 'warning' : 'error';
      // Print the message and line number, even during local runs.
      console.log(`  ${message.type}, line ${line}: ${message.message || '(no message)'}`);
      // Also add a file annotation when running on GitHub.
      annotate(level, filename, message.message || message.type, line);
    // End the loop through messages.
    }
  // Handle unreadable files, network failures, or invalid responses here.
  } catch (error) {
    // Remember that this incomplete check must fail the overall run.
    failed = true;
    // Save INCOMPLETE and its reason in the report.
    reports.push({ file: filename, status: 'INCOMPLETE', error: error.message });
    // Print the failure in the log.
    console.error(`${filename}: INCOMPLETE — ${error.message}`);
    // Add an error annotation on GitHub too.
    annotate('error', filename, error.message);
  // End the try/catch for this file.
  }
// End the loop after checking all files, even if some failed.
}

// Record when the checks finished (UTC), the service address, and all file results.
const report = { checkedAt: new Date().toISOString(), endpoint, files: reports };
// Save readable JSON using two-space indentation and a final newline.
await writeFile(path.join(reportDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
// Start a Markdown summary intended for people to read.
const summary = [
  // Add a heading and a blank line.
  '# W3C HTML validation', '',
  // Make a bullet containing the filename and status for each result.
  ...reports.map(result => `- ${JSON.stringify(result.file)}: **${result.status}**${
    // Add the request-failure reason or the number of markup errors and warnings.
    result.error ? ` — ${result.error}` : ` (${result.errors} errors, ${result.warnings} warnings)`}`),
  // Explain which service ran the checks and that warnings do not fail validation.
  '', 'Checked source files with https://validator.w3.org/nu/. Warnings are advisory.', '',
// Join the summary's lines with newline characters.
].join('\n');
// Save the human-readable summary in the report folder.
await writeFile(path.join(reportDir, 'summary.md'), summary);
// If GitHub provides a summary file, append our report so it appears on the run page.
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
// Return failure (1) if anything failed or was incomplete, otherwise success (0).
process.exitCode = failed ? 1 : 0;
