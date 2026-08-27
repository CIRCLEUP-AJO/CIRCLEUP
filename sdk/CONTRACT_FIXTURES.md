# Contract Argument Compatibility Fixtures

## Purpose

Contract methods can change their signatures (parameter order, types, or removal) in ways that compile in TypeScript but fail at runtime with opaque Soroban host errors. These XDR fixtures protect the SDK ↔ contract boundary by encoding valid argument combinations and verifying they remain decodable across contract changes.

## How It Works

Each fixture is a base64-encoded XDR `ScVal` vector representing one contract method's arguments:

```typescript
const FIXTURE = encodeFixture([
  scAddress(CREATOR_ADDR),
  scAddressVec([MEMBER_A, MEMBER_B]),
  scI128(100_000_000n),
  scU32(120_960),
]);
```

If the contract method signature changes, the corresponding fixture test will fail, surfacing the break in CI before it reaches production.

## Coverage

### CircleFactory Contract

| Method         | Parameters                                                           | Fixtures                    |
|----------------|----------------------------------------------------------------------|-----------------------------|
| `create_circle`| `creator: Address, members: Vec<Address>, round_amount: i128, round_deadline_ledgers: u32` | Valid, single member, boundary deadline |

### Circle Contract

| Method              | Parameters                  | Fixtures          |
|---------------------|-----------------------------|-------------------|
| `initialize`        | Same as create_circle       | Valid             |
| `join`              | `member: Address`           | Member address    |
| `contribute`        | `member: Address`           | Member address    |
| `payout`            | None                        | Empty args        |
| `mark_default`      | `member: Address`           | Member address    |
| `close`             | `caller: Address`           | Caller address    |
| `get_config`        | None                        | Empty args        |
| `get_status`        | None                        | Empty args        |
| `get_current_round` | None                        | Empty args        |
| `get_collateral`    | `member: Address`           | Member address    |
| `get_defaults`      | `member: Address`           | Member address    |
| `has_contributed`   | `member: Address, round_index: u32` | Round 0, Round 5 |

### Reputation Contract

| Method      | Parameters                        | Fixtures               |
|-------------|-----------------------------------|------------------------|
| `score`     | `member: Address`                 | Member address         |
| `increment` | `member: Address, delta: i32`     | Positive, negative     |

## Running the Tests

```bash
cd sdk
npm test -- contractFixtures.test.ts --run
```

All tests should pass. If a test fails after updating a contract:

1. **Expected failure**: The contract signature changed
   - Update the SDK client method to match
   - Update the fixture encoding
   - Update the test assertions
   - Document the breaking change in `CHANGELOG.md`

2. **Unexpected failure**: XDR encoding bug or SDK regression
   - Investigate the mismatch
   - File an issue with reproduction steps

## Maintaining Fixtures

### Adding a New Contract Method

1. Create a new `describe` block in `contractFixtures.test.ts`:
   ```typescript
   describe("new_method", () => {
     const FIXTURE = encodeFixture([
       scAddress(MEMBER_ADDR),
       scU32(42),
     ]);

     it("new_method with valid args", () => {
       assertFixture(FIXTURE, [MEMBER_ADDR, 42]);
     });
   });
   ```

2. Add boundary cases (min/max values, edge inputs):
   ```typescript
   const FIXTURE_BOUNDARY = encodeFixture([
     scAddress(MEMBER_ADDR),
     scU32(0), // minimum valid value
   ]);
   ```

3. Run the test suite to verify the fixture encodes and decodes correctly.

### Updating an Existing Fixture

When a contract method signature changes:

1. Update the fixture encoding to match the new signature
2. Update the `assertFixture` call with the new expected values
3. Verify all tests pass
4. Commit the updated fixture

Example:
```typescript
// Old signature: join(member: Address)
const FIXTURE_OLD = encodeFixture([scAddress(MEMBER_ADDR)]);

// New signature: join(member: Address, referrer: Address)
const FIXTURE_NEW = encodeFixture([
  scAddress(MEMBER_ADDR),
  scAddress(REFERRER_ADDR),
]);
```

### Fixture Stability

Fixtures must be **deterministic** — encoding the same arguments must produce identical XDR:

```typescript
it("encoded fixtures are stable", () => {
  const reencoded = encodeFixture([
    scAddress(CREATOR_ADDR),
    scAddressVec([MEMBER_A, MEMBER_B]),
    scI128(100_000_000n),
    scU32(120_960),
  ]);
  expect(reencoded).toBe(FIXTURE_VALID);
});
```

This test fails if:
- The SDK encoding changes (Stellar SDK update)
- The helper functions (scAddress, scU32, etc.) have a bug
- Platform-specific XDR serialization differences

## Integration with CI

The fixture tests run in CI on every pull request. A failing fixture test blocks the merge, preventing accidental contract breakage from reaching production.

### GitHub Actions Workflow

```yaml
- name: Test contract fixtures
  run: npm test -- contractFixtures.test.ts --run
  working-directory: sdk
```

## Debugging Failed Fixtures

If a fixture test fails:

1. **Check the error message** — it will show which argument index mismatched:
   ```
   AssertionError: expected [MEMBER_A, 42] but received [MEMBER_A, 43]
   ```

2. **Inspect the XDR** — decode the fixture manually to see what it contains:
   ```typescript
   const decoded = decodeFixture(FIXTURE);
   console.log(decoded.map(scValToNative));
   ```

3. **Compare contract and SDK** — verify the SDK client method matches the contract signature:
   ```rust
   // contracts/circle/src/lib.rs
   pub fn join(env: Env, member: Address) { ... }
   ```
   ```typescript
   // sdk/src/client.ts
   async join(member: Keypair): Promise<TxResult> {
     return this.buildAndSend(member, this.circleAddress, "join", [
       scAddress(member.publicKey()),
     ]);
   }
   ```

4. **Check XDR type tags** — use `switch().name` to inspect the ScVal type:
   ```typescript
   const val = decoded[0];
   console.log(val.switch().name); // "scvAddress"
   ```

## Benefits

### Prevents Runtime Failures
Contract signature changes surface as test failures during development, not as production incidents.

### Documents Contract Interface
Fixtures serve as executable documentation of every public contract method's signature.

### Guards Against SDK Regressions
If a Stellar SDK update breaks XDR encoding, the fixtures catch it before deployment.

### Enables Confident Refactoring
Developers can refactor SDK builders (scAddress, scU32, etc.) knowing the fixtures will catch encoding bugs.

## Limitations

### Does Not Validate Contract Logic
Fixtures verify argument encoding, not that the contract will accept the arguments. A contract might reject valid XDR due to business logic (e.g., "circle already joined").

### Requires Manual Maintenance
When contracts change, developers must update fixtures manually. Automated fixture generation from contract ABIs is a future improvement.

### No Cross-Contract Call Testing
Fixtures test individual methods in isolation. Integration tests (e.g., create_circle → join → contribute) are covered by `sdk/src/__tests__/pipeline.test.ts`.

## Future Improvements

### Auto-Generate Fixtures from ABI
Parse Soroban contract metadata (when available) to generate fixture scaffolding:
```bash
npm run generate-fixtures -- contracts/circle/target/wasm32-unknown-unknown/release/circle.wasm
```

### Fixture Versioning
Track fixtures per contract version so the SDK can support multiple contract releases:
```typescript
const FIXTURES_V1 = { ... };
const FIXTURES_V2 = { ... };
```

### Fuzz Testing
Generate random valid arguments and verify they encode/decode without throwing:
```typescript
fc.assert(
  fc.property(fc.address(), fc.nat(), (addr, roundIndex) => {
    const args = [scAddress(addr), scU32(roundIndex)];
    const encoded = encodeFixture(args);
    const decoded = decodeFixture(encoded);
    expect(decoded).toHaveLength(args.length);
  })
);
```
