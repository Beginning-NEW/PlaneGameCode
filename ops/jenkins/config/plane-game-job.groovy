// Auditable seed-job input. Every trigger path remains disabled until the
// Operations, security, QA, and CTO enablement gates are all approved.
pipelineJob('plane-game/main-cd') {
  description('Main-only CD with mutually exclusive durable poller or webhook admission.')
  disabled(true)
  parameters {
    stringParam('TRIGGER_SOURCE', '', 'poller or webhook; must match the reviewed global selector')
    stringParam('GITHUB_SHA', '', 'Exact successful main push SHA')
    stringParam('GITHUB_RUN_ID', '', 'Exact Actions run id')
    stringParam('GITHUB_RUN_ATTEMPT', '', 'Exact Actions run attempt')
    stringParam('TRIGGER_ID', '', 'Immutable trigger identity')
    stringParam('WEBHOOK_DELIVERY_UUID', '', 'Webhook-only UUID; empty in poller mode')
  }
  definition {
    cpsScm {
      scm {
        git {
          remote { url('https://github.com/Beginning-NEW/PlaneGameCode.git') }
          branch('*/main')
          extensions { cloneOptions { noTags(true); shallow(false) } }
        }
      }
      scriptPath('Jenkinsfile')
      lightweight(false)
    }
  }
}
