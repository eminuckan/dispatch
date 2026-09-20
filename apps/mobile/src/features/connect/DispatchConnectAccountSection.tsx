import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsSection } from "../settings/components/SettingsSection";
import { getDispatchConnectAuthClient, type DispatchConnectAuthClient } from "./authClient";

export function DispatchConnectAccountSection() {
  const client = getDispatchConnectAuthClient();
  if (!client) return null;
  return (
    <View className="mb-5">
      <ConfiguredDispatchConnectAccountSection client={client} />
    </View>
  );
}

function ConfiguredDispatchConnectAccountSection({
  client,
}: {
  readonly client: DispatchConnectAuthClient;
}) {
  const { data: session, isPending, error, refetch } = client.useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  const signIn = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setActionError("Enter your email and password.");
      return;
    }
    setActionError(null);
    setIsActing(true);
    try {
      const result = await client.signIn.email({ email: normalizedEmail, password });
      if (result.error) {
        setActionError(result.error.message ?? "Could not sign in to Dispatch Connect.");
        return;
      }
      await refetch();
      setPassword("");
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Could not sign in to Dispatch Connect.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const signOut = async () => {
    setActionError(null);
    setIsActing(true);
    try {
      const result = await client.signOut();
      if (result.error) {
        setActionError(result.error.message ?? "Could not sign out of Dispatch Connect.");
        return;
      }
      await refetch();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Could not sign out of Dispatch Connect.",
      );
    } finally {
      setIsActing(false);
    }
  };

  const signUp = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setActionError("Enter your email and password.");
      return;
    }
    setActionError(null);
    setIsActing(true);
    try {
      const result = await client.signUp.email({
        email: normalizedEmail,
        password,
        name: normalizedEmail,
      });
      if (result.error) {
        setActionError(result.error.message ?? "Could not create the Dispatch Connect account.");
        return;
      }
      await refetch();
      setPassword("");
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Could not create the Dispatch Connect account.",
      );
    } finally {
      setIsActing(false);
    }
  };

  return (
    <SettingsSection title="Dispatch Connect">
      <View className="gap-3 px-4 py-4">
        {isPending ? (
          <View className="flex-row items-center gap-2 py-1">
            <ActivityIndicator size="small" />
            <Text className="text-sm text-foreground-muted">Checking account…</Text>
          </View>
        ) : session ? (
          <>
            <View className="gap-1">
              <Text className="text-base font-dispatch-bold text-foreground">Signed in</Text>
              <Text className="text-sm text-foreground-muted">{session.user.email}</Text>
            </View>
            <ConnectionSheetButton
              compact
              fullWidth
              icon="xmark"
              label={isActing ? "Signing out..." : "Sign out"}
              disabled={isActing}
              onPress={() => void signOut()}
            />
          </>
        ) : (
          <>
            <View className="gap-1">
              <Text className="text-base font-dispatch-bold text-foreground">Optional account</Text>
              <Text className="text-sm leading-normal text-foreground-muted">
                Sign in to discover environments through Dispatch Connect. Direct pairing works
                without an account.
              </Text>
            </View>
            <ConnectionFormField
              label="Email"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              value={email}
              onChangeText={setEmail}
            />
            <ConnectionFormField
              label="Password"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              textContentType="password"
              value={password}
              onChangeText={setPassword}
            />
            <ConnectionSheetButton
              compact
              fullWidth
              icon="person.crop.circle"
              label={isActing ? "Signing in..." : "Sign in"}
              disabled={isActing}
              tone="primary"
              onPress={() => void signIn()}
            />
            <ConnectionSheetButton
              compact
              fullWidth
              icon="person.crop.circle"
              label={isActing ? "Working..." : "Create account"}
              disabled={isActing}
              onPress={() => void signUp()}
            />
          </>
        )}
        {actionError || error?.message ? (
          <Text className="text-xs text-danger-foreground">{actionError ?? error?.message}</Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
