import { hash, verify } from "@node-rs/argon2";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as spanish from "@zxcvbn-ts/language-es-es";

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
// The top zxcvbn score: out of reach even for an offline attack on a stolen hash
const MIN_SCORE = 4;

const strength = new ZxcvbnFactory({
  translations: spanish.translations,
  graphs: common.adjacencyGraphs,
  dictionary: { ...common.dictionary, ...spanish.dictionary },
});

// OWASP Password Storage baseline for argon2id
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Verified when the account does not exist so both paths take the same time
let dummyHash: Promise<string> | null = null;

/**
 * Tells why a new password is not acceptable, or null when it is
 *
 * @param   password  Candidate password
 * @param   personal  Data of the account the password must not lean on, such as email and name
 *
 * @return  The rejection reason in Spanish, or null
 */
export function passwordProblem(password: string, personal: string[]): string | null {
  if (password.length < MIN_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_LENGTH} caracteres`;
  }

  if (password.length > MAX_LENGTH) {
    return `La contraseña no puede pasar de ${MAX_LENGTH} caracteres`;
  }

  // zxcvbn only matches whole entries, so "Mariana del Campo" must reach it as separate words
  const words = personal.flatMap((value) =>
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  );

  const { score, feedback } = strength.check(password, words);
  if (score < MIN_SCORE) {
    return feedback.warning ?? feedback.suggestions[0] ?? "La contraseña es fácil de adivinar";
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
