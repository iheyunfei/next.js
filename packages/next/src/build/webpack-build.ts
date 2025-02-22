import type { webpack } from 'next/dist/compiled/webpack/webpack'
import chalk from 'next/dist/compiled/chalk'
import formatWebpackMessages from '../client/dev/error-overlay/format-webpack-messages'
import { nonNullable } from '../lib/non-nullable'
import {
  COMPILER_NAMES,
  CLIENT_STATIC_FILES_RUNTIME_MAIN_APP,
  APP_CLIENT_INTERNALS,
  PHASE_PRODUCTION_BUILD,
} from '../shared/lib/constants'
import { runCompiler } from './compiler'
import * as Log from './output/log'
import getBaseWebpackConfig from './webpack-config'
import { NextError } from '../lib/is-error'
import { injectedClientEntries } from './webpack/plugins/flight-client-entry-plugin'
import { TelemetryPlugin } from './webpack/plugins/telemetry-plugin'
import { NextBuildContext } from './build-context'
import { isMainThread, parentPort, Worker, workerData } from 'worker_threads'
import { createEntrypoints } from './entries'
import loadConfig from '../server/config'
import { trace } from '../trace'

type CompilerResult = {
  errors: webpack.StatsError[]
  warnings: webpack.StatsError[]
  stats: (webpack.Stats | undefined)[]
}

type SingleCompilerResult = {
  errors: webpack.StatsError[]
  warnings: webpack.StatsError[]
  stats: webpack.Stats | undefined
}

function isTelemetryPlugin(plugin: unknown): plugin is TelemetryPlugin {
  return plugin instanceof TelemetryPlugin
}

async function webpackBuildImpl(): Promise<number> {
  let result: CompilerResult | null = {
    warnings: [],
    errors: [],
    stats: [],
  }
  let webpackBuildStart
  const nextBuildSpan = NextBuildContext.nextBuildSpan!
  const buildSpinner = NextBuildContext.buildSpinner
  const dir = NextBuildContext.dir!

  const runWebpackSpan = nextBuildSpan.traceChild('run-webpack-compiler')
  const entrypoints = await nextBuildSpan
    .traceChild('create-entrypoints')
    .traceAsyncFn(() =>
      createEntrypoints({
        buildId: NextBuildContext.buildId!,
        config: NextBuildContext.config!,
        envFiles: NextBuildContext.loadedEnvFiles!,
        isDev: false,
        rootDir: dir,
        pageExtensions: NextBuildContext.config!.pageExtensions!,
        pagesDir: NextBuildContext.pagesDir!,
        appDir: NextBuildContext.appDir!,
        pages: NextBuildContext.mappedPages!,
        appPaths: NextBuildContext.mappedAppPages!,
        previewMode: NextBuildContext.previewProps!,
        rootPaths: NextBuildContext.mappedRootPaths!,
      })
    )

  const commonWebpackOptions = {
    isServer: false,
    buildId: NextBuildContext.buildId!,
    config: NextBuildContext.config!,
    target: NextBuildContext.config!.target!,
    appDir: NextBuildContext.appDir!,
    pagesDir: NextBuildContext.pagesDir!,
    rewrites: NextBuildContext.rewrites!,
    reactProductionProfiling: NextBuildContext.reactProductionProfiling!,
    noMangling: NextBuildContext.noMangling!,
  }

  const configs = await runWebpackSpan
    .traceChild('generate-webpack-config')
    .traceAsyncFn(() =>
      Promise.all([
        getBaseWebpackConfig(dir, {
          ...commonWebpackOptions,
          middlewareMatchers: entrypoints.middlewareMatchers,
          runWebpackSpan,
          compilerType: COMPILER_NAMES.client,
          entrypoints: entrypoints.client,
        }),
        getBaseWebpackConfig(dir, {
          ...commonWebpackOptions,
          runWebpackSpan,
          middlewareMatchers: entrypoints.middlewareMatchers,
          compilerType: COMPILER_NAMES.server,
          entrypoints: entrypoints.server,
        }),
        getBaseWebpackConfig(dir, {
          ...commonWebpackOptions,
          runWebpackSpan,
          middlewareMatchers: entrypoints.middlewareMatchers,
          compilerType: COMPILER_NAMES.edgeServer,
          entrypoints: entrypoints.edgeServer,
        }),
      ])
    )

  const clientConfig = configs[0]

  if (
    clientConfig.optimization &&
    (clientConfig.optimization.minimize !== true ||
      (clientConfig.optimization.minimizer &&
        clientConfig.optimization.minimizer.length === 0))
  ) {
    Log.warn(
      `Production code optimization has been disabled in your project. Read more: https://nextjs.org/docs/messages/minification-disabled`
    )
  }

  webpackBuildStart = process.hrtime()

  // We run client and server compilation separately to optimize for memory usage
  await runWebpackSpan.traceAsyncFn(async () => {
    // Run the server compilers first and then the client
    // compiler to track the boundary of server/client components.
    let clientResult: SingleCompilerResult | null = null

    // During the server compilations, entries of client components will be
    // injected to this set and then will be consumed by the client compiler.
    injectedClientEntries.clear()

    const serverResult = await runCompiler(configs[1], {
      runWebpackSpan,
    })
    const edgeServerResult = configs[2]
      ? await runCompiler(configs[2], { runWebpackSpan })
      : null

    // Only continue if there were no errors
    if (!serverResult.errors.length && !edgeServerResult?.errors.length) {
      injectedClientEntries.forEach((value, key) => {
        const clientEntry = clientConfig.entry as webpack.EntryObject
        if (key === APP_CLIENT_INTERNALS) {
          clientEntry[CLIENT_STATIC_FILES_RUNTIME_MAIN_APP] = [
            // TODO-APP: cast clientEntry[CLIENT_STATIC_FILES_RUNTIME_MAIN_APP] to type EntryDescription once it's available from webpack
            // @ts-expect-error clientEntry['main-app'] is type EntryDescription { import: ... }
            ...clientEntry[CLIENT_STATIC_FILES_RUNTIME_MAIN_APP].import,
            value,
          ]
        } else {
          clientEntry[key] = {
            dependOn: [CLIENT_STATIC_FILES_RUNTIME_MAIN_APP],
            import: value,
          }
        }
      })

      clientResult = await runCompiler(clientConfig, {
        runWebpackSpan,
      })
    }

    result = {
      warnings: ([] as any[])
        .concat(
          clientResult?.warnings,
          serverResult?.warnings,
          edgeServerResult?.warnings
        )
        .filter(nonNullable),
      errors: ([] as any[])
        .concat(
          clientResult?.errors,
          serverResult?.errors,
          edgeServerResult?.errors
        )
        .filter(nonNullable),
      stats: [
        clientResult?.stats,
        serverResult?.stats,
        edgeServerResult?.stats,
      ],
    }
  })
  result = nextBuildSpan
    .traceChild('format-webpack-messages')
    .traceFn(() => formatWebpackMessages(result, true)) as CompilerResult

  NextBuildContext.telemetryPlugin = (
    clientConfig as webpack.Configuration
  ).plugins?.find(isTelemetryPlugin)

  const webpackBuildEnd = process.hrtime(webpackBuildStart)
  if (buildSpinner) {
    buildSpinner.stopAndPersist()
  }

  if (result.errors.length > 0) {
    // Only keep the first few errors. Others are often indicative
    // of the same problem, but confuse the reader with noise.
    if (result.errors.length > 5) {
      result.errors.length = 5
    }
    let error = result.errors.filter(Boolean).join('\n\n')

    console.error(chalk.red('Failed to compile.\n'))

    if (
      error.indexOf('private-next-pages') > -1 &&
      error.indexOf('does not contain a default export') > -1
    ) {
      const page_name_regex = /'private-next-pages\/(?<page_name>[^']*)'/
      const parsed = page_name_regex.exec(error)
      const page_name = parsed && parsed.groups && parsed.groups.page_name
      throw new Error(
        `webpack build failed: found page without a React Component as default export in pages/${page_name}\n\nSee https://nextjs.org/docs/messages/page-without-valid-component for more info.`
      )
    }

    console.error(error)
    console.error()

    if (
      error.indexOf('private-next-pages') > -1 ||
      error.indexOf('__next_polyfill__') > -1
    ) {
      const err = new Error(
        'webpack config.resolve.alias was incorrectly overridden. https://nextjs.org/docs/messages/invalid-resolve-alias'
      ) as NextError
      err.code = 'INVALID_RESOLVE_ALIAS'
      throw err
    }
    const err = new Error('Build failed because of webpack errors') as NextError
    err.code = 'WEBPACK_ERRORS'
    throw err
  } else {
    if (result.warnings.length > 0) {
      Log.warn('Compiled with warnings\n')
      console.warn(result.warnings.filter(Boolean).join('\n\n'))
      console.warn()
    } else {
      Log.info('Compiled successfully')
    }
    return webpackBuildEnd[0]
  }
}

// the main function when this file is run as a worker
async function workerMain() {
  const { buildContext } = workerData
  // setup new build context from the serialized data passed from the parent
  Object.assign(NextBuildContext, buildContext)

  /// load the config because it's not serializable
  NextBuildContext.config = await loadConfig(
    PHASE_PRODUCTION_BUILD,
    NextBuildContext.dir!,
    undefined,
    undefined,
    true
  )
  NextBuildContext.nextBuildSpan = trace('next-build')

  try {
    const result = await webpackBuildImpl()
    parentPort!.postMessage(result)
  } catch (e) {
    parentPort!.postMessage(e)
  } finally {
    process.exit(0)
  }
}

if (!isMainThread) {
  workerMain()
}

async function webpackBuildWithWorker() {
  const {
    config,
    telemetryPlugin,
    buildSpinner,
    nextBuildSpan,
    ...prunedBuildContext
  } = NextBuildContext
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      buildContext: prunedBuildContext,
    },
  })

  const result = await new Promise((resolve, reject) => {
    worker.on('message', resolve)
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`))
      }
    })
  })

  return result as number
}

export async function webpackBuild() {
  const config = NextBuildContext.config!

  if (config.experimental.webpackBuildWorker) {
    return await webpackBuildWithWorker()
  } else {
    return await webpackBuildImpl()
  }
}
