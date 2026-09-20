import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionSheetButton } from "./ConnectionSheetButton";
import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { getDispatchConnectAuthClient } from "../connect/authClient";
import { ensureDispatchConnectDevice } from "../connect/device";
import {
  formatDispatchConnectCode,
  parseDispatchConnectCode,
  readDispatchConnectCodeFromQrPayload,
  redeemDispatchConnectPairing,
  resolveDispatchConnectUrl,
} from "../connect/dispatchConnect";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const params = route.params ?? {};
  // Deep-link prefill exists for development automation only. A production
  // link must not arrive with attacker-chosen host and token already filled.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  const shouldAutoConnect =
    __DEV__ &&
    routePairingUrl.length > 0 &&
    (params.autoConnect === "1" || params.autoConnect === "true");
  const insets = useSafeAreaInsets();
  const dispatchConnectUrl = resolveDispatchConnectUrl();
  const dispatchConnectAuthClient = getDispatchConnectAuthClient();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [connectCodeInput, setConnectCodeInput] = useState("");
  const [entryMode, setEntryMode] = useState<"direct" | "connect">("direct");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(params.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerLocked, setScannerLocked] = useState(false);
  const attemptedAutoConnectRef = useRef<string | null>(null);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled =
    isSubmitting ||
    (entryMode === "connect"
      ? connectCodeInput.replace(/-/gu, "").length !== 12
      : hostInput.trim().length === 0);

  useEffect(() => {
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (routePairingUrl.length === 0) {
      return;
    }

    const { host, code } = parsePairingUrl(routePairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [routePairingUrl]);

  useEffect(() => {
    if (pairingConnectionError) {
      setIsSubmitting(false);
    }
  }, [pairingConnectionError]);

  const handleHostChange = useCallback((value: string) => {
    setConnectError(null);
    setHostInput(value);
  }, []);

  const handleCodeChange = useCallback((value: string) => {
    setConnectError(null);
    setCodeInput(value);
  }, []);

  const handleConnectCodeChange = useCallback((value: string) => {
    setConnectError(null);
    setConnectCodeInput(formatDispatchConnectCode(value));
  }, []);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    if (permission.canAskAgain) {
      Alert.alert(
        "Camera access needed",
        "Allow camera access to scan an environment pairing QR code.",
      );
      return;
    }

    Alert.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, [cameraPermission?.granted, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerLocked(false);
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);

      try {
        const dispatchConnectCode = readDispatchConnectCodeFromQrPayload(data);
        if (dispatchConnectCode) {
          if (!dispatchConnectUrl) {
            throw new Error("Dispatch Connect is not configured for this build.");
          }
          setEntryMode("connect");
          setConnectError(null);
          setConnectCodeInput(dispatchConnectCode);
          setShowScanner(false);
          return;
        }

        const pairingUrl = extractPairingUrlFromQrPayload(data);
        const { host, code } = parsePairingUrl(pairingUrl);
        setEntryMode("direct");
        setConnectError(null);
        setHostInput(host);
        setCodeInput(code);
        onChangeConnectionPairingUrl(pairingUrl);
        setShowScanner(false);
      } catch (error) {
        Alert.alert(
          "Invalid QR code",
          error instanceof Error ? error.message : "Scanned QR code was not recognized.",
        );
      } finally {
        setTimeout(() => {
          setScannerLocked(false);
        }, 600);
      }
    },
    [dispatchConnectUrl, onChangeConnectionPairingUrl, scannerLocked],
  );

  const connectAndClose = useCallback(
    async (pairingUrl: string, replaceWithHome: boolean) => {
      setIsSubmitting(true);
      onChangeConnectionPairingUrl(pairingUrl);
      try {
        const result = await onConnectPress(pairingUrl);
        if (AsyncResult.isSuccess(result)) {
          if (replaceWithHome || !navigation.canGoBack()) {
            navigation.dispatch(StackActions.replace("Home"));
          } else {
            navigation.goBack();
          }
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [navigation, onChangeConnectionPairingUrl, onConnectPress],
  );

  const handleSubmit = useCallback(async () => {
    setConnectError(null);
    await connectAndClose(buildPairingUrl(hostInput, codeInput), false);
  }, [codeInput, connectAndClose, hostInput]);

  const handleDispatchConnectSubmit = useCallback(async () => {
    setConnectError(null);
    setIsSubmitting(true);
    try {
      if (!dispatchConnectUrl || !dispatchConnectAuthClient) {
        throw new Error("Dispatch Connect is not configured for this build.");
      }
      const session = await dispatchConnectAuthClient.getSession();
      if (!session.data) {
        throw new Error("Sign in to Dispatch Connect from Environments first.");
      }
      const cookie = await dispatchConnectAuthClient.getCookie();
      if (!cookie) {
        throw new Error("Dispatch Connect session is unavailable. Sign in again and retry.");
      }
      const code = parseDispatchConnectCode(connectCodeInput);
      const deviceId = await ensureDispatchConnectDevice({ baseUrl: dispatchConnectUrl, cookie });
      const environment = await redeemDispatchConnectPairing({
        baseUrl: dispatchConnectUrl,
        deviceId,
        code,
        cookie,
      });

      let lastFailure: unknown = null;
      for (const endpoint of environment.endpoints) {
        const pairingUrl = buildPairingUrl(endpoint.httpBaseUrl, code);
        onChangeConnectionPairingUrl(pairingUrl);
        const result = await onConnectPress(pairingUrl);
        if (AsyncResult.isSuccess(result)) {
          setConnectCodeInput("");
          if (!navigation.canGoBack()) {
            navigation.dispatch(StackActions.replace("Home"));
          } else {
            navigation.goBack();
          }
          return;
        }
        if (AsyncResult.isFailure(result)) {
          lastFailure = Cause.squash(result.cause);
        }
      }
      throw lastFailure instanceof Error
        ? lastFailure
        : new Error("Could not reach the environment through Dispatch Connect.");
    } catch (cause) {
      setConnectError(
        cause instanceof Error ? cause.message : "Could not pair through Dispatch Connect.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    connectCodeInput,
    dispatchConnectAuthClient,
    dispatchConnectUrl,
    navigation,
    onChangeConnectionPairingUrl,
    onConnectPress,
  ]);

  useEffect(() => {
    if (!shouldAutoConnect || attemptedAutoConnectRef.current === routePairingUrl) {
      return;
    }

    attemptedAutoConnectRef.current = routePairingUrl;
    void connectAndClose(routePairingUrl, true);
  }, [connectAndClose, routePairingUrl, shouldAutoConnect]);

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew"}
      title={showScanner ? "Scan QR Code" : "Add Environment"}
      actions={[
        {
          accessibilityLabel: showScanner ? "Close scanner" : "Scan QR code",
          icon: showScanner ? "xmark" : Platform.OS === "ios" ? "qrcode.viewfinder" : "camera",
          tintColor: headerIconColor,
          onPress: () => {
            if (showScanner) {
              closeScanner();
            } else {
              void openScanner();
            }
          },
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <View collapsable={false} className="gap-5">
          {showScanner ? (
            cameraPermission?.granted ? (
              <View className="overflow-hidden rounded-[24px] border-continuous">
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-5 py-8">
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  Camera permission is required to scan a QR code.
                </Text>
                <ConnectionSheetButton
                  compact
                  icon="camera"
                  label="Allow camera"
                  tone="secondary"
                  onPress={() => {
                    void openScanner();
                  }}
                />
              </View>
            )
          ) : (
            <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
              {dispatchConnectUrl ? (
                <ConnectionSheetButton
                  compact
                  fullWidth
                  icon="link"
                  label={entryMode === "connect" ? "Use direct host" : "Use Dispatch Connect code"}
                  disabled={isSubmitting}
                  onPress={() => {
                    setConnectError(null);
                    setEntryMode((current) => (current === "connect" ? "direct" : "connect"));
                  }}
                />
              ) : null}

              {entryMode === "connect" && dispatchConnectUrl ? (
                <>
                  <ConnectionFormField
                    label="Dispatch Connect code"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    placeholder="ABCD-EFGH-JKLM"
                    value={connectCodeInput}
                    onChangeText={handleConnectCodeChange}
                  />
                  <Text className="text-xs leading-normal text-foreground-muted">
                    Sign in from Environments, then enter the code shown by the environment.
                    Tailscale is tried first when available.
                  </Text>
                </>
              ) : (
                <>
                  <ConnectionFormField
                    label="Host"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="192.168.1.100:8080"
                    value={hostInput}
                    onChangeText={handleHostChange}
                  />

                  <ConnectionFormField
                    label="Pairing code"
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="abc-123-xyz"
                    value={codeInput}
                    onChangeText={handleCodeChange}
                  />
                </>
              )}

              {(connectError ?? pairingConnectionError) ? (
                <ErrorBanner message={connectError ?? pairingConnectionError ?? ""} />
              ) : null}

              <View className={Platform.OS === "android" ? "flex-row justify-end" : undefined}>
                <ConnectionSheetButton
                  icon="plus"
                  label={isSubmitting ? "Pairing..." : "Add environment"}
                  disabled={connectDisabled}
                  tone="primary"
                  onPress={() => {
                    void (entryMode === "connect" ? handleDispatchConnectSubmit() : handleSubmit());
                  }}
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
