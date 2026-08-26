#!/usr/bin/env ts-node
/**
 * validate-env.ts — Environment profile validation (Issue #84)
 *
 * Validates the active environment profile and rejects incompatible
 * network / contract address combinations.  Profile values come from a
 * named profile file (profiles/<profile>.env) merged on top of the package
 * .env file so operators can switch profiles without editing live configs.
 *
 * Profiles:
 *   testnet   — Stellar Testnet; empty contract addresses are acceptable.
 *   staging   — Staging network; all contract addresses must be set.
 *   production — Mainnet; testnet RPC and testnet passphrases are rejected.
 *
 * Usage:
 *   npx ts-node src/validate-env.ts [--profile <name>] [--component <name>]
 *
 * Options:
 *   --profile   testnet | staging | production  (default: read CIRCLEUP_PROFILE env var)
 *   --component app | indexer | scripts | all   (default: all)
 *
 * Exit codes:
 *   0 — Profile is valid; safe to start the component.
 *   1 — Profile is invalid; do not deploy or start the component.
 *
 * This script is read-only and safe for contributor machines.
 */

import fs from 'fs';
import path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

type Profile = 'testnet' | 'staging' | 'production';
type Component = 'app' | 'indexer' | 'scripts';

interface ValidationResult {
  name: string;
  pass: boolean;
  message: string;
}

interface EnvMap {
  [key: string]: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');

/** RPC hostnames that identify the Stellar Testnet. */
const TESTNET_RPC_PATTERNS = [
  'soroban-testnet.stellar.org',
  'testnet.stellar.org',
  'testnet',
];

/** The canonical Testnet network passphrase. */
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

/** The canonical Mainnet network passphrase. */
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** Variables that must not be empty in staging and production. */
const CONTRACT_VARS = [
  'CIRCLE_FACTORY_ADDRESS',
  'REPUTATION_ADDRESS',
  'USDC_ADDRESS',
];

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(): { profile: Profile; components: Component[] } {
  const argv = process.argv.slice(2);

  let profileArg: string | undefined =
    argv[argv.indexOf('--profile') + 1] ??
    process.env.CIRCLEUP_PROFILE;

  let componentArg: string | undefined =
    argv[argv.indexOf('--component') + 1] ?? 'all';

  const validProfiles: Profile[] = ['testnet', 'staging', 'production'];
  const validComponents: Array<Component | 'all'> = ['app', 'indexer', 'scripts', 'all'];

  if (!profileArg || !validProfiles.includes(profileArg as Profile)) {
    console.error(
      `Error: --profile must be one of: ${validProfiles.join(', ')}\n` +
        `Got: ${profileArg ?? '(unset)'}\n` +
        'Set CIRCLEUP_PROFILE or pass --profile <name>',
    );
    process.exit(1);
  }

  if (!validComponents.includes(componentArg as Component | 'all')) {
    console.error(
      `Error: --component must be one of: ${validComponents.join(', ')}\n` +
        `Got: ${componentArg}`,
    );
    process.exit(1);
  }

  const components: Component[] =
    componentArg === 'all' ? ['app', 'indexer', 'scripts'] : [componentArg as Component];

  return { profile: profileArg as Profile, components };
}

// ── Env file loading ──────────────────────────────────────────────────────────

/** Parse a KEY=VALUE env file, ignoring comments and blank lines. */
function parseEnvFile(filePath: string): EnvMap {
  const result: EnvMap = {};
  if (!fs.existsSync(filePath)) return result;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

/**
 * Load environment for a component by merging, in order:
 *   1. Component .env.example (defaults / documentation)
 *   2. Profile file (profiles/<profile>.env)
 *   3. Component .env (local overrides, if present — not committed)
 *   4. Actual process.env (CI / shell overrides take highest precedence)
 */
function loadEnv(component: Component, profile: Profile): EnvMap {
  const componentDir = path.join(ROOT, component);
  const exampleFile = path.join(componentDir, '.env.example');
  const profileFile = path.join(PROFILES_DIR, `${profile}.env`);
  const localFile = path.join(componentDir, '.env');

  const merged: EnvMap = {
    ...parseEnvFile(exampleFile),
    ...parseEnvFile(profileFile),
    ...parseEnvFile(localFile),
  };

  // Process env vars take precedence over all files
  for (const key of Object.keys(merged)) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key]!;
    }
  }

  return merged;
}

// ── Validation rules ──────────────────────────────────────────────────────────

function pass(name: string, message: string): ValidationResult {
  return { name, pass: true, message };
}

function fail(name: string, message: string): ValidationResult {
  return { name, pass: false, message };
}

/** Rule: production must not use a testnet RPC URL. */
function ruleNoTestnetRpcInProduction(
  env: EnvMap,
  profile: Profile,
): ValidationResult {
  const rpcKey = 'STELLAR_RPC_URL';
  const rpcUrl = env[rpcKey] ?? env['NEXT_PUBLIC_STELLAR_RPC_URL'] ?? '';

  if (profile !== 'production') {
    return pass('rpc-url', `Profile=${profile}: RPC URL check relaxed (${rpcUrl || 'unset'})`);
  }

  const isTestnet = TESTNET_RPC_PATTERNS.some(p =>
    rpcUrl.toLowerCase().includes(p.toLowerCase()),
  );

  if (!rpcUrl) {
    return fail(
      'rpc-url',
      `[PRODUCTION] STELLAR_RPC_URL is not set — production must have an explicit mainnet RPC`,
    );
  }

  if (isTestnet) {
    return fail(
      'rpc-url',
      `[PRODUCTION] STELLAR_RPC_URL contains a testnet hostname: "${rpcUrl}"\n` +
        '  Production must never silently fall back to testnet. Set a mainnet RPC URL.',
    );
  }

  return pass('rpc-url', `[PRODUCTION] RPC URL is set and does not reference testnet: ${rpcUrl}`);
}

/** Rule: production must use the mainnet passphrase. */
function ruleProductionPassphrase(
  env: EnvMap,
  profile: Profile,
): ValidationResult {
  const passphraseKey = 'NETWORK_PASSPHRASE';
  const passphrase =
    env[passphraseKey] ?? env['NEXT_PUBLIC_NETWORK_PASSPHRASE'] ?? '';

  if (profile === 'testnet') {
    return pass('passphrase', `Profile=testnet: passphrase check relaxed`);
  }

  if (profile === 'staging') {
    if (passphrase === TESTNET_PASSPHRASE || !passphrase) {
      return fail(
        'passphrase',
        `[STAGING] NETWORK_PASSPHRASE is "${passphrase || 'unset'}".\n` +
          '  Staging should use its own dedicated network, not the public testnet passphrase.\n' +
          '  If this is intentional, explicitly document it in the profile file.',
      );
    }
    return pass('passphrase', `[STAGING] Passphrase is set and not the public testnet passphrase`);
  }

  // production
  if (passphrase !== MAINNET_PASSPHRASE) {
    return fail(
      'passphrase',
      `[PRODUCTION] NETWORK_PASSPHRASE must be "${MAINNET_PASSPHRASE}".\n` +
        `  Got: "${passphrase || '(unset)'}"`,
    );
  }

  return pass('passphrase', `[PRODUCTION] Passphrase is the correct mainnet passphrase`);
}

/** Rule: staging and production must have all contract addresses set. */
function ruleContractAddresses(
  env: EnvMap,
  profile: Profile,
): ValidationResult {
  if (profile === 'testnet') {
    return pass(
      'contract-addresses',
      `Profile=testnet: empty contract addresses are acceptable for local dev`,
    );
  }

  const missing = CONTRACT_VARS.filter(k => !env[k]);

  if (missing.length > 0) {
    return fail(
      'contract-addresses',
      `[${profile.toUpperCase()}] Missing contract addresses: ${missing.join(', ')}\n` +
        '  All contract addresses must be set explicitly in staging and production.',
    );
  }

  return pass(
    'contract-addresses',
    `[${profile.toUpperCase()}] All contract addresses are set: ${CONTRACT_VARS.join(', ')}`,
  );
}

/** Rule: network and contract addresses must be mutually consistent. */
function ruleNetworkContractCompatibility(
  env: EnvMap,
  profile: Profile,
): ValidationResult {
  const rpcUrl = env['STELLAR_RPC_URL'] ?? env['NEXT_PUBLIC_STELLAR_RPC_URL'] ?? '';
  const factoryAddr = env['CIRCLE_FACTORY_ADDRESS'] ?? env['NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS'] ?? '';

  // If the RPC is mainnet but addresses look like testnet placeholders, warn
  const isTestnetRpc = TESTNET_RPC_PATTERNS.some(p =>
    rpcUrl.toLowerCase().includes(p.toLowerCase()),
  );
  const addressesSet = CONTRACT_VARS.some(k => !!env[k]);

  if (profile === 'production' && isTestnetRpc && addressesSet) {
    return fail(
      'network-contract-compat',
      `[PRODUCTION] A testnet RPC URL is paired with non-empty contract addresses.\n` +
        '  This combination will reject valid mainnet transactions.\n' +
        `  RPC: ${rpcUrl}\n  CIRCLE_FACTORY_ADDRESS: ${factoryAddr}`,
    );
  }

  if (profile === 'staging' && isTestnetRpc) {
    // Staging on testnet is a known pattern — warn but don't fail
    console.log(
      `  [warn] staging is using a testnet RPC (${rpcUrl}). ` +
        'If this is intentional, document it in profiles/staging.env.',
    );
  }

  return pass('network-contract-compat', 'Network and contract address combination is consistent');
}

/** Rule: no production secrets in profile files (basic check). */
function ruleNoSecretsInProfileFile(profile: Profile): ValidationResult {
  const profileFile = path.join(PROFILES_DIR, `${profile}.env`);
  if (!fs.existsSync(profileFile)) {
    return pass('no-profile-secrets', `profiles/${profile}.env not found — nothing to check`);
  }

  const content = fs.readFileSync(profileFile, 'utf8');

  // Private keys are 56 chars for Stellar (Sxxx...) or 64-char hex strings
  const secretPatterns = [
    /^S[A-Z2-7]{55}$/m,               // Stellar secret key
    /SECRET[_\s]*KEY\s*=\s*S[A-Z]/im, // SECRET_KEY=S...
    /PRIVATE[_\s]*KEY\s*=\s*\S/im,    // PRIVATE_KEY=...
  ];

  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      return fail(
        'no-profile-secrets',
        `profiles/${profile}.env appears to contain a secret key or private key.\n` +
          '  Profile files must not store secrets — use environment variables or a secret manager.',
      );
    }
  }

  return pass('no-profile-secrets', `profiles/${profile}.env contains no obvious secrets`);
}

// ── Per-component validation ──────────────────────────────────────────────────

function validateComponent(component: Component, profile: Profile): ValidationResult[] {
  const env = loadEnv(component, profile);

  const rules: Array<() => ValidationResult> = [
    () => ruleNoTestnetRpcInProduction(env, profile),
    () => ruleProductionPassphrase(env, profile),
    () => ruleContractAddresses(env, profile),
    () => ruleNetworkContractCompatibility(env, profile),
    () => ruleNoSecretsInProfileFile(profile),
  ];

  return rules.map(fn => {
    try {
      return fn();
    } catch (err) {
      return fail('internal', `Validation rule threw: ${(err as Error).message}`);
    }
  });
}

// ── Runner ────────────────────────────────────────────────────────────────────

function run(): void {
  const { profile, components } = parseArgs();

  console.log(`CircleUp environment profile validation`);
  console.log(`Profile:    ${profile}`);
  console.log(`Components: ${components.join(', ')}\n`);

  // Check that the profile file exists (warn, not fail, for testnet)
  const profileFile = path.join(PROFILES_DIR, `${profile}.env`);
  if (!fs.existsSync(profileFile)) {
    const severity = profile === 'testnet' ? '[warn]' : '[error]';
    console.log(
      `  ${severity} profiles/${profile}.env not found. ` +
        'Create it from profiles/testnet.env as a template.\n',
    );
    if (profile !== 'testnet') {
      process.exit(1);
    }
  }

  let allPassed = true;

  for (const component of components) {
    console.log(`── ${component} ──`);
    const results = validateComponent(component, profile);
    for (const r of results) {
      const icon = r.pass ? '✓' : '✗';
      const label = r.pass ? 'PASS' : 'FAIL';
      console.log(`  [${label}] ${icon} ${r.name}: ${r.message}`);
      if (!r.pass) allPassed = false;
    }
    console.log('');
  }

  if (allPassed) {
    console.log(`Profile "${profile}" is valid for: ${components.join(', ')}`);
    process.exit(0);
  } else {
    console.log(
      `Profile "${profile}" validation failed. ` +
        'Fix the issues above before deploying or starting services.',
    );
    process.exit(1);
  }
}

run();
