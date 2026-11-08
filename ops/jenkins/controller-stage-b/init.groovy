import com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey
import com.cloudbees.plugins.credentials.CredentialsScope
import com.cloudbees.plugins.credentials.CredentialsProvider
import com.cloudbees.plugins.credentials.SystemCredentialsProvider
import hudson.model.Item
import hudson.model.Node
import hudson.model.User
import hudson.plugins.sshslaves.SSHLauncher
import hudson.plugins.sshslaves.verifiers.ManuallyProvidedKeyVerificationStrategy
import hudson.security.HudsonPrivateSecurityRealm
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.security.SecureRandom
import jenkins.model.Jenkins

def fail = { String message ->
  System.err.println("Stage B invariant failed: ${message}")
  System.exit(78)
}

def controller = Jenkins.get()
def home = controller.getRootDir().toPath()
def readyFile = home.resolve('.stage-b-ready')
Files.deleteIfExists(readyFile)

controller.setNumExecutors(0)
controller.setSlaveAgentPort(-1)
controller.save()

if (!(controller.getSecurityRealm() instanceof HudsonPrivateSecurityRealm)) {
  fail('local security realm is required')
}
def realm = (HudsonPrivateSecurityRealm) controller.getSecurityRealm()
def adminId = 'plane-admin'
def bootstrapFile = Path.of('/run/secrets/PLANE_ADMIN_BOOTSTRAP_BCRYPT')
def bootstrapMarker = home.resolve('.stage-b-admin-bootstrap.sha256')
def admin = User.getById(adminId, false)
def adminInitialized = admin?.getProperty(HudsonPrivateSecurityRealm.Details.class) != null
def bootstrapPresent = Files.isRegularFile(bootstrapFile, LinkOption.NOFOLLOW_LINKS) && Files.isReadable(bootstrapFile)

if (!adminInitialized && !bootstrapPresent) {
  fail('fresh home requires the one-time admin bcrypt bootstrap file')
}

if (bootstrapPresent) {
  if (Files.size(bootstrapFile) > 128L) {
    fail('admin bcrypt bootstrap file is oversized')
  }
  def hashedPassword = Files.readString(bootstrapFile, StandardCharsets.UTF_8).trim()
  if (!(hashedPassword ==~ /#jbcrypt:\$2a\$(0[4-9]|1[0-8])\$[.\/A-Za-z0-9]{53}/)) {
    fail('admin bootstrap must be one Jenkins #jbcrypt hash')
  }
  def digestBytes = MessageDigest.getInstance('SHA-256').digest(hashedPassword.getBytes(StandardCharsets.UTF_8))
  def digest = digestBytes.collect { String.format('%02x', it & 0xff) }.join()
  if (adminInitialized && Files.isRegularFile(bootstrapMarker) && Files.readString(bootstrapMarker).trim() == digest) {
    fail('admin bootstrap file must be removed after its one-time application')
  }
  admin = realm.createAccountWithHashedPassword(adminId, hashedPassword)
  admin.setFullName('PlaneGame Stage B Administrator')
  admin.save()
  def markerTemp = home.resolve('.stage-b-admin-bootstrap.sha256.tmp')
  Files.writeString(markerTemp, "${digest}\n", StandardCharsets.US_ASCII,
    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)
  Files.move(markerTemp, bootstrapMarker, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
}

admin = User.getById(adminId, false)
if (admin?.getProperty(HudsonPrivateSecurityRealm.Details.class) == null) {
  fail('fixed local admin principal is not initialized')
}

def gatewayId = 'plane-webhook-gateway'
def gateway = User.getById(gatewayId, false)
if (gateway?.getProperty(HudsonPrivateSecurityRealm.Details.class) == null) {
  def randomPassword = new BigInteger(320, new SecureRandom()).toString(36)
  gateway = realm.createAccount(gatewayId, randomPassword)
  gateway.setFullName('PlaneGame Webhook Gateway')
  gateway.save()
}

def credentials = SystemCredentialsProvider.getInstance().getCredentials()
def requireCredential = { String id, Class type, CredentialsScope scope ->
  def matches = credentials.findAll { it.id == id }
  if (matches.size() != 1 || !type.isInstance(matches[0]) || matches[0].scope != scope) {
    fail("credential metadata is invalid for ${id}")
  }
  return matches[0]
}

def ssh = (BasicSSHUserPrivateKey) requireCredential(
  'plane-game-agent-ssh', BasicSSHUserPrivateKey.class, CredentialsScope.SYSTEM)
if (!ssh.privateKey) {
  fail('required SSH credential value resolved empty')
}

def agent = controller.getNode('plane-game-cd-rootless')
def launcher = agent?.getLauncher()
def agentValid = agent != null &&
  agent.getNumExecutors() == 1 &&
  agent.getMode() == Node.Mode.EXCLUSIVE &&
  agent.getRemoteFS().startsWith('/home/plane-preflight/') &&
  agent.getLabelString().split(/\s+/).contains('plane-game-cd-rootless') &&
  launcher instanceof SSHLauncher &&
  launcher.getCredentialsId() == 'plane-game-agent-ssh' &&
  launcher.getHostKeyVerificationStrategy() instanceof ManuallyProvidedKeyVerificationStrategy &&
  launcher.getHostKeyVerificationStrategy().getKey()?.startsWith('ssh-ed25519 ')
if (!agentValid) {
  fail('bounded exclusive SSH agent is invalid')
}

def adminAuth = admin.impersonate2()
def gatewayAuth = gateway.impersonate2()
def job = controller.getItemByFullName('plane-game/main-cd')
if (!controller.getACL().hasPermission2(adminAuth, Jenkins.ADMINISTER)) {
  fail('fixed local admin lacks Overall/Administer')
}
if (!controller.getACL().hasPermission2(gatewayAuth, Jenkins.READ) ||
    controller.getACL().hasPermission2(gatewayAuth, Jenkins.ADMINISTER) ||
    controller.getACL().hasPermission2(gatewayAuth, Jenkins.RUN_SCRIPTS) ||
    controller.getACL().hasPermission2(gatewayAuth, CredentialsProvider.VIEW)) {
  fail('gateway global authorization is not least privilege')
}
def jobFolder = controller.getItem('plane-game')
if (jobFolder == null || !jobFolder.getACL().hasPermission2(gatewayAuth, Item.READ) ||
    jobFolder.getACL().hasPermission2(gatewayAuth, Item.CONFIGURE) ||
    job == null || !job.isDisabled() ||
    !job.getACL().hasPermission2(gatewayAuth, Item.READ) ||
    !job.getACL().hasPermission2(gatewayAuth, Item.BUILD) ||
    job.getACL().hasPermission2(gatewayAuth, Item.CONFIGURE) ||
    job.getACL().hasPermission2(gatewayAuth, Item.DELETE)) {
  fail('gateway job authorization or disabled state is invalid')
}

def readyTemp = home.resolve('.stage-b-ready.tmp')
Files.writeString(readyTemp, 'stage-b-ready-v2\n', StandardCharsets.US_ASCII,
  StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)
Files.move(readyTemp, readyFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
println('Stage B invariant passed: bootstrap, authorization, SSH credential, controller, agent, and disabled job are ready')
