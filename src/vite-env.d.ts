/// <reference types="vite/client" />

interface DominionThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly colorScheme: 'dark' | 'light';
  readonly themeColor: string;
  readonly assets: {
    readonly variant: string;
    readonly fallback: string;
  };
  readonly availability: {
    readonly kind: 'public' | 'feature-flag';
    readonly enabled: boolean;
    readonly featureFlag: string | null;
    readonly requiresEntitlement: boolean;
  };
}

interface DominionThemeRuntime {
  readonly version: number;
  readonly storageKey: string;
  readonly rootAttribute: string;
  readonly changeEvent: string;
  readonly defaultThemeId: string;
  readonly themes: readonly DominionThemeDefinition[];
  getTheme(themeId: string): DominionThemeDefinition | null;
  isThemeAvailable(themeId: string): boolean;
  resolveTheme(themeId: string): string;
  readStoredTheme(): string;
  applyTheme(themeId: string, options?: { notify?: boolean }): string;
  applyStoredTheme(options?: { notify?: boolean }): string;
  setTheme(themeId: string): string;
  getActiveTheme(): string;
  getAssetVariants(themeId: string): string[];
  toggleTheme(): string;
}

interface Window {
  readonly DominionThemeRuntime: DominionThemeRuntime;
}
