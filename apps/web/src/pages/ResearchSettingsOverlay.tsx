import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceResearchSettingsView } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

export function ResearchSettingsOverlay({
  config,
  onConfigChange,
  onBusyChange,
}: {
  config: SpaceResearchSettingsView | null | undefined;
  onConfigChange: (config: SpaceResearchSettingsView | null) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const modelId = useId();
  const projectId = useId();
  const executableId = useId();
  const modeId = useId();
  const [model, setModel] = useState(config?.model ?? "");
  const [project, setProject] = useState(config?.project ?? "");
  const [executable, setExecutable] = useState(config?.executable ?? "");
  const [mode, setMode] = useState<"accept-edits" | "plan">(config?.mode ?? "accept-edits");
  const [pending, setPending] = useState<"save" | "disable" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModel(config?.model ?? "");
    setProject(config?.project ?? "");
    setExecutable(config?.executable ?? "");
    setMode(config?.mode ?? "accept-edits");
  }, [config]);

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  const busy = pending !== null;

  function markPending(next: "save" | "disable" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  async function save() {
    setError(null);
    markPending("save");
    try {
      const next = await rpc.research.save({
        model: model.trim(),
        ...(project.trim() ? { project: project.trim() } : {}),
        ...(executable.trim() ? { executable: executable.trim() } : {}),
        mode,
      });
      onConfigChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
    } finally {
      markPending(null);
    }
  }

  async function disable() {
    setError(null);
    markPending("disable");
    try {
      await rpc.research.disable();
      onConfigChange(null);
      setModel("");
      setProject("");
      setExecutable("");
      setMode("accept-edits");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
    } finally {
      markPending(null);
    }
  }

  return (
    <div data-testid="research-settings" className="flex flex-col gap-4">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Field>
        <FieldLabel htmlFor={modelId}>
          <Trans>Model</Trans>
        </FieldLabel>
        <Input
          id={modelId}
          value={model}
          disabled={busy}
          onChange={(event) => setModel(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={projectId}>
          <Trans>Project</Trans>
        </FieldLabel>
        <Input
          id={projectId}
          value={project}
          disabled={busy}
          onChange={(event) => setProject(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={executableId}>
          <Trans>Executable</Trans>
        </FieldLabel>
        <Input
          id={executableId}
          value={executable}
          disabled={busy}
          onChange={(event) => setExecutable(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={modeId}>
          <Trans>Mode</Trans>
        </FieldLabel>
        <NativeSelect
          id={modeId}
          className="w-full"
          value={mode}
          disabled={busy}
          onChange={(event) => setMode(event.target.value as "accept-edits" | "plan")}
        >
          <NativeSelectOption value="accept-edits">accept-edits</NativeSelectOption>
          <NativeSelectOption value="plan">plan</NativeSelectOption>
        </NativeSelect>
      </Field>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !model.trim()}
          onClick={() => void save()}
        >
          <Trans>Save</Trans>
        </Button>
        {config ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void disable()}
          >
            <Trans>Disable</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
