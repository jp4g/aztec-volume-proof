export const precision = (n: bigint = 1n, decimals: bigint = 18n) =>
    n * 10n ** decimals;