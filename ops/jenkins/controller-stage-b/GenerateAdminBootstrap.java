import java.io.Console;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;

final class GenerateAdminBootstrap {
  private static String hash(char[] password) throws Exception {
    try {
      Class<?> bcrypt = Class.forName("org.mindrot.jbcrypt.BCrypt");
      Method gensalt = bcrypt.getMethod("gensalt", int.class);
      Method hashpw = bcrypt.getMethod("hashpw", String.class, String.class);
      String salt = (String) gensalt.invoke(null, 12);
      return (String) hashpw.invoke(null, new String(password), salt);
    } catch (ClassNotFoundException ignored) {
      Class<?> encoderClass = Class.forName(
          "org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder");
      Constructor<?> constructor = encoderClass.getConstructor(int.class);
      Object encoder = constructor.newInstance(12);
      return (String) encoderClass.getMethod("encode", CharSequence.class)
          .invoke(encoder, new String(password));
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 1) {
      throw new IllegalArgumentException("one output path is required");
    }
    Console console = System.console();
    if (console == null) {
      throw new IllegalStateException("an interactive terminal is required");
    }
    Path target = Path.of(args[0]);
    if (Files.exists(target)) {
      throw new IllegalStateException("bootstrap target already exists");
    }
    char[] first = console.readPassword("New plane-admin password: ");
    char[] second = console.readPassword("Confirm plane-admin password: ");
    Path temporary = null;
    try {
      if (first.length < 16 || !Arrays.equals(first, second)) {
        throw new IllegalArgumentException("passwords differ or are shorter than 16 characters");
      }
      String encoded = hash(first).replaceFirst("^\\$2[by]\\$", "\\$2a\\$");
      if (!encoded.matches("^\\$2a\\$(0[4-9]|1[0-8])\\$[./A-Za-z0-9]{53}$")) {
        throw new IllegalStateException("Jenkins-compatible bcrypt generation failed");
      }
      temporary = Files.createTempFile(
          target.getParent(), ".admin-bootstrap-bcrypt.", ".tmp",
          PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
      Files.writeString(temporary, "#jbcrypt:" + encoded + "\n", StandardCharsets.US_ASCII);
      try {
        Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE);
      } catch (AtomicMoveNotSupportedException ignored) {
        Files.move(temporary, target);
      }
      temporary = null;
    } finally {
      Arrays.fill(first, '\0');
      Arrays.fill(second, '\0');
      if (temporary != null) Files.deleteIfExists(temporary);
    }
  }
}
