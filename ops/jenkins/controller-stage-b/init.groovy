import com.cloudbees.plugins.credentials.SystemCredentialsProvider
import hudson.model.Node
import hudson.plugins.sshslaves.SSHLauncher
import hudson.plugins.sshslaves.verifiers.ManuallyProvidedKeyVerificationStrategy
import jenkins.model.Jenkins

def controller = Jenkins.get()
controller.setNumExecutors(0)
controller.setSlaveAgentPort(-1)
controller.save()

def agent = controller.getNode('plane-game-cd-rootless')
def launcher = agent?.getLauncher()
def credential = SystemCredentialsProvider.getInstance().getCredentials().find {
  it.id == 'plane-game-agent-ssh'
}
def valid = agent != null &&
  agent.getNumExecutors() == 1 &&
  agent.getMode() == Node.Mode.EXCLUSIVE &&
  agent.getRemoteFS().startsWith('/home/plane-preflight/') &&
  agent.getLabelString().split(/\s+/).contains('plane-game-cd-rootless') &&
  launcher instanceof SSHLauncher &&
  launcher.getCredentialsId() == 'plane-game-agent-ssh' &&
  launcher.getHostKeyVerificationStrategy() instanceof ManuallyProvidedKeyVerificationStrategy &&
  launcher.getHostKeyVerificationStrategy().getKey()?.startsWith('ssh-ed25519 ') &&
  credential != null

if (!valid) {
  System.err.println('Stage B invariant failed: bounded exclusive SSH agent or SYSTEM credential is invalid')
  System.exit(78)
}

println('Stage B invariant passed: controllerExecutors=0 agentPort=-1 agent=plane-game-cd-rootless')
