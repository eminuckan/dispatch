import { getBranchPrefixValidationError, normalizeBranchPrefix } from "@dispatch/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";

export function BranchPrefixField(props: {
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => Promise<boolean>;
  readonly resetLabel: string;
  readonly onReset: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? props.value ?? "";
  const error = getBranchPrefixValidationError(value);
  const canSave =
    !props.disabled &&
    draft !== null &&
    error === null &&
    normalizeBranchPrefix(value) !== props.value;

  return (
    <View className="gap-3 p-4">
      <Text className="text-lg text-foreground android:text-base">Branch prefix</Text>
      <Text className="text-sm text-foreground-muted">
        Used for generated branch names and new branch forms. Leave empty for no prefix.
      </Text>
      <View className="flex-row items-center gap-3">
        <AppTextInput
          value={value}
          onChangeText={setDraft}
          placeholder={props.value === null ? "Mixed values" : "No prefix"}
          accessibilityLabel="Branch prefix"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!props.disabled}
          className="min-h-11 min-w-0 flex-1 rounded-xl bg-sheet-solid px-3 py-2 text-base"
        />
        <Pressable
          accessibilityRole="button"
          disabled={!canSave}
          className="min-h-11 justify-center px-2 disabled:opacity-[0.45]"
          onPress={async () => {
            if (await props.onValueChange(normalizeBranchPrefix(value))) setDraft(null);
          }}
        >
          <Text className="text-base text-primary-text">Save</Text>
        </Pressable>
      </View>
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled}
        className="min-h-10 justify-center self-start disabled:opacity-[0.45]"
        onPress={async () => {
          if (await props.onReset()) setDraft(null);
        }}
      >
        <Text className="text-sm text-primary-text">{props.resetLabel}</Text>
      </Pressable>
    </View>
  );
}
