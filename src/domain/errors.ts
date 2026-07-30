/** Typed errors, so the CLI and the web UI can render failures usefully. */

export class MiseError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MISE_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A quantity could not be converted, usually for want of a density or unit weight. */
export class ConversionError extends MiseError {
  constructor(message: string) {
    super(message, 'CONVERSION');
  }
}

/** An item, recipe, lot or plan entry was referenced but does not exist. */
export class NotFoundError extends MiseError {
  readonly ref: string;

  constructor(kind: string, ref: string) {
    super(`No ${kind} with id or name "${ref}".`, 'NOT_FOUND');
    this.ref = ref;
  }
}

/** A recipe (transitively) contains itself. Explosion would never terminate. */
export class CycleError extends MiseError {
  readonly path: readonly string[];

  constructor(path: readonly string[]) {
    super(`Recursive recipe detected: ${path.join(' -> ')}`, 'CYCLE');
    this.path = path;
  }
}

/** Stock or supply is insufficient for an operation that demanded it be present. */
export class ShortageError extends MiseError {
  readonly itemId: string;
  readonly shortBy: number;

  constructor(itemId: string, shortBy: number, unit: string) {
    super(`Insufficient stock of "${itemId}": short by ${shortBy.toFixed(2)} ${unit}.`, 'SHORTAGE');
    this.itemId = itemId;
    this.shortBy = shortBy;
  }
}

/** The database is internally inconsistent (dangling reference, bad yield, ...). */
export class ValidationError extends MiseError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Database validation failed:\n  - ${issues.join('\n  - ')}`, 'VALIDATION');
    this.issues = issues;
  }
}
