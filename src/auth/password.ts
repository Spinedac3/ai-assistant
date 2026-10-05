import { hash, verify } from "@node-rs/argon2";

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

// The most common choices in public breach lists; a longer list adds little at this length
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "qwertyuiopas",
  "password1234",
  "password12345",
  "passwordpassword",
  "contraseña123",
  "contrasena123",
  "contraseña1234",
  "administrator",
  "administrador",
  "iloveyou1234",
  "welcome12345",
  "bienvenido123",
  "letmein12345",
  "qwerty123456",
  "abc123456789",
  "aaaaaaaaaaaa",
  "111111111111",
  "000000000000",
]);

// OWASP Password Storage baseline for argon2id
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Verified when the account does not exist so both paths take the same time
let dummyHash: Promise<string> | null = null;

/**
 * Tells why a new password is not acceptable, or null when it is
 *
 * @param   password  Candidate password
 * @param   email     Account email, which the password must not contain
 *
 * @return  The rejection reason in Spanish, or null
 */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_LENGTH} caracteres`;
  }

  if (password.length > MAX_LENGTH) {
    return `La contraseña no puede pasar de ${MAX_LENGTH} caracteres`;
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "La contraseña es demasiado común";
  }

  const localPart = email.split("@")[0]?.toLowerCase() ?? "";
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    return "La contraseña no puede contener el usuario del correo";
  }

  return null;
}

/**
 * Hashes a password with argon2id
 *
 * @param   password  Plain password
 *
 * @return  The encoded hash, salt included
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Checks a password against a stored hash; a missing hash still costs one verification
 *
 * @param   storedHash  Encoded hash, or null when the account has none
 * @param   password    Plain password
 *
 * @return  Whether the password matches
 */
export async function verifyPassword(
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  dummyHash ??= hashPassword("not-a-real-account-password");

  try {
    const matches = await verify(storedHash ?? (await dummyHash), password);

    return storedHash !== null && matches;
  } catch {
    return false;
  }
}
