import { deleteConfigValue, getConfigValue, setConfigValue } from "./configEntries";

const LOCAL_CORPUS_NAMESPACE = "local_corpus";
const LOCAL_CORPUS_ROOT_KEY = "root_path";

export interface LocalCorpusConfig {
  rootPath: string | null;
  configured: boolean;
}

export async function getLocalCorpusRoot(): Promise<string | null> {
  try {
    const value = await getConfigValue(LOCAL_CORPUS_NAMESPACE, LOCAL_CORPUS_ROOT_KEY);
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export async function setLocalCorpusRoot(rootPath: string): Promise<void> {
  await setConfigValue(LOCAL_CORPUS_NAMESPACE, LOCAL_CORPUS_ROOT_KEY, rootPath);
}

export async function clearLocalCorpusRoot(): Promise<void> {
  await deleteConfigValue(LOCAL_CORPUS_NAMESPACE, LOCAL_CORPUS_ROOT_KEY);
}

export async function getLocalCorpusConfig(): Promise<LocalCorpusConfig> {
  const rootPath = await getLocalCorpusRoot();
  return { rootPath, configured: rootPath !== null };
}
