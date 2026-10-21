import argon2 from 'argon2';

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, { type: argon2.argon2id });

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false; // a malformed hash must never crash a login
  }
}

let dummyHash: Promise<string> | undefined;
export async function spendTimeLikeARealCheck(plain: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(await dummyHash, plain);
}