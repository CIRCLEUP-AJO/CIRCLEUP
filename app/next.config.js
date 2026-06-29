/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  webpack: (config, { isServer }) => {
    // sodium-native is a Node-only native module used by stellar-base for signing.
    // On the browser it is never needed (Freighter handles signing).
    // Alias it to an empty module so webpack doesn't choke on it.
    config.resolve.alias = {
      ...config.resolve.alias,
      "sodium-native": false,
    };

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        buffer: false,
      };
    }

    return config;
  },
};

module.exports = nextConfig;
