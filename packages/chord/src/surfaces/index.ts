// The client surfaces' portable part (slice 11): plugin scripts that register themselves, a host's loaded plugins,
// themes, and messages and languages.

export { followActiveLanguage, hostLanguage, type LanguageFollower } from "./active-language.ts";
export { followActiveTheme, type ThemeFollower } from "./active-theme.ts";
export { formatNumber, formatTime } from "./format.ts";
export { createLanguage, type Language, type MessagesReport } from "./language.ts";
export { LoadedFacets, type Prepared, type SetEntry } from "./loaded.ts";
export { LocaleChoice, localeChoiceFacet } from "./locale-choice.ts";
export {
	type Catalog,
	type CatalogShape,
	type DataKeys,
	defineMessages,
	type MessageArgs,
	type MessageData,
	type MessageParam,
	MessageSchema,
	type Messages,
	type MessagesOf,
	type MessageValue,
	type Translator,
} from "./messages.ts";
export {
	type ClientModules,
	evaluateRegistered,
	type FacetFunction,
	REGISTER,
	type RegisteredScript,
	registeredSource,
} from "./registered.ts";
export { ThemeChoice, themeChoiceFacet } from "./theme-choice.ts";
export {
	activeTheme,
	BASE_ROLES,
	type BaseRole,
	type ColorDepth,
	FALLBACK_THEMES,
	type Theme,
	type ThemePick,
	Themes,
	terminalColor,
	themesFacet,
	themeVariables,
} from "./themes.ts";
export {
	type Translation,
	type TranslationIndex,
	Translations,
	translationsFacet,
} from "./translations.ts";
