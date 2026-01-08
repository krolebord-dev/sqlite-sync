const dbIdRegex = /^[a-zA-Z][a-zA-Z\-0-9]{2,63}$/;

export function validateDbId(dbId: string) {
  if (!dbIdRegex.test(dbId)) {
    throw new Error("Invalid dbId. Must be between 3 and 64 characters long and start with a letter.");
  }
}
