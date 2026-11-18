import * as core from '@actions/core'
import { pathToFileURL } from 'url'
import {
  acquire,
  candidateVersions,
  getOpenTofuVersions,
  getTerraformVersions,
  loadModule,
  resolveVersion,
  runPreRunCommands,
  writeCredentials,
} from '@core'
import { InputError, loadInputs } from './inputs.js'
import { checkFormat, reportedVersion } from './fmt.js'
import { validateSubscription } from './subscription.js'

const CHECK_FAILED = 'check-failed'

/**
 * Publishes why the step failed.
 *
 * Both spellings are set because the documented contract carries the hyphenated
 * and the underscored name, and consumers depend on either one.
 */
function setFailureReason(reason: string): void {
  core.setOutput('failure-reason', reason)
  core.setOutput('failure_reason', reason)
}

/**
 * Prepares the environment, then resolves and downloads the tool to run.
 *
 * Version selection is delegated to the shared core so that the whole suite
 * agrees on it. This action is pinned to OpenTofu — the same code path the
 * Docker image expressed as `OPENTOFU=true` in its env block.
 */
async function prepareTool(modulePath: string): Promise<string> {
  writeCredentials({
    cloudTokens: process.env.TERRAFORM_CLOUD_TOKENS,
    httpCredentials: process.env.TERRAFORM_HTTP_CREDENTIALS,
    sshKey: process.env.TERRAFORM_SSH_KEY,
  })

  const openTofu = true
  const terraform = await getTerraformVersions()
  const tofu = await getOpenTofuVersions(process.env.GITHUB_TOKEN)
  const versions = candidateVersions(terraform, tofu)

  const resolution = resolveVersion(
    {
      modulePath,
      workspaceRoot: process.env.GITHUB_WORKSPACE || process.cwd(),
      openTofu,
    },
    { module: loadModule(modulePath, openTofu), versions, env: process.env }
  )

  if (!resolution) {
    throw new Error(
      'No OpenTofu release matched. A pre-release has to be named exactly, e.g. OPENTOFU_VERSION=1.6.0-alpha3'
    )
  }

  core.info(
    `Using ${resolution.version.product} ${resolution.version} because ${resolution.reason}`
  )

  const binary = await acquire(resolution.version)

  // After the tool is installed, not before. Upstream orders it this way, and a
  // pre-run command that expects the binary to exist would otherwise run too
  // early.
  await runPreRunCommands(process.env.TERRAFORM_PRE_RUN)

  return binary
}

export async function run(): Promise<number> {
  await validateSubscription()

  let inputs
  try {
    inputs = loadInputs()
  } catch (error) {
    if (error instanceof InputError) {
      core.error(error.message)
      return 1
    }
    throw error
  }

  let result
  try {
    const binary = await prepareTool(inputs.path)
    core.info(`Checking formatting with ${reportedVersion(binary) ?? 'an unknown version'}`)
    result = await checkFormat(binary, inputs.path, inputs.workspaceRoot)
  } catch (error) {
    core.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (!result.unformatted.length) {
    core.info('Every OpenTofu file is in canonical format.')
    return 0
  }

  if (result.output.trim()) {
    core.startGroup('Formatting differences')
    core.info(result.output.trimEnd())
    core.endGroup()
  }

  // Annotate each file so the problem shows up on the pull request diff rather
  // than only in the job log.
  for (const file of result.unformatted) {
    core.error("Not in canonical format; run 'tofu fmt' to fix.", { file })
  }

  setFailureReason(CHECK_FAILED)

  const count = result.unformatted.length
  core.error(`${count} ${count === 1 ? 'file is' : 'files are'} not in canonical format.`)
  return 1
}

/**
 * Only self-start when invoked directly, so the module can still be imported by
 * a test. `import.meta.url` is the ESM equivalent of the `require.main` check.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      core.setFailed(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
