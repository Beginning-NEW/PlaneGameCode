// Imported by JCasC. The host-owned selector defaults disabled and is mounted read-only.
def triggerMode = new File('/run/secrets/PLANE_CD_TRIGGER_MODE').text.trim()
if (!(triggerMode in ['disabled', 'poller', 'webhook'])) {
  throw new IllegalStateException('fixed trigger selector is invalid')
}
folder('plane-game') {
  authorization {
    userPermission('hudson.model.Item.Read', 'plane-webhook-gateway')
    userPermission('hudson.model.Item.Read', 'plane-actions-poller')
  }
}

pipelineJob('plane-game/main-cd') {
  description('Stage B main-only CD; trigger selector, job, poller timer, and webhook remain disabled pending separate gates.')
  disabled(triggerMode == 'disabled')
  parameters {
    stringParam('TRIGGER_SOURCE', '', 'poller or webhook; must match the reviewed global selector')
    stringParam('GITHUB_SHA', '', 'Exact successful main push SHA')
    stringParam('GITHUB_RUN_ID', '', 'Exact Actions run id')
    stringParam('GITHUB_RUN_ATTEMPT', '', 'Exact Actions run attempt')
    stringParam('TRIGGER_ID', '', 'Immutable trigger identity')
    stringParam('WEBHOOK_DELIVERY_UUID', '', 'Webhook-only UUID; must be empty in poller mode')
  }
  authorization {
    userPermission('hudson.model.Item.Read', 'plane-webhook-gateway')
    userPermission('hudson.model.Item.Build', 'plane-webhook-gateway')
    userPermission('hudson.model.Item.Read', 'plane-actions-poller')
    userPermission('hudson.model.Item.Build', 'plane-actions-poller')
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
