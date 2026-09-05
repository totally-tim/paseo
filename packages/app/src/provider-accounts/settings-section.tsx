import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AccountOperation, ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SettingsSection } from "@/screens/settings/settings-section";
import { ProviderUsageCard } from "@/provider-usage/card";
import { settingsStyles } from "@/styles/settings";
import { useProviderAccounts } from "./use-provider-accounts";
import { openAccountForm } from "./account-form-model";

type Manage = ReturnType<typeof useProviderAccounts>["manage"];

export function ProviderAccountsSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const accounts = useProviderAccounts(serverId);
  const { manage, refresh: refreshAccounts } = accounts;
  const [editing, setEditing] = useState<ProviderAccount | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const perform = useCallback(
    async (operation: AccountOperation) => {
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        const result = await manage(operation);
        if (operation.kind === "add" && result.account) setEditing(result.account);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("providerAccounts.operationError"));
      } finally {
        setPending(false);
      }
    },
    [manage, pending, t],
  );
  const addClaude = useCallback(() => {
    void perform({
      kind: "add",
      provider: "claude",
      label: t("providerAccounts.newAccount", { provider: "Claude" }),
    });
  }, [perform, t]);
  const addCodex = useCallback(() => {
    void perform({
      kind: "add",
      provider: "codex",
      label: t("providerAccounts.newAccount", { provider: "Codex" }),
    });
  }, [perform, t]);
  const refresh = useCallback(() => {
    void refreshAccounts();
  }, [refreshAccounts]);
  const policyOptions = useMemo(
    () => [
      {
        id: "pause-unattended",
        value: "pause-unattended",
        label: t("providerAccounts.pauseUnattended"),
      },
      { id: "allow", value: "allow", label: t("providerAccounts.allowUnknown") },
    ],
    [t],
  );
  const changePolicy = useCallback(
    (value: string) => {
      if (value === "allow" || value === "pause-unattended")
        void perform({ kind: "policy", policy: { unknownQuota: value } });
    },
    [perform],
  );
  const size = useIsCompactFormFactor() ? "md" : "sm";
  if (!accounts.supported) return null;
  const liveEditing =
    accounts.data?.accounts.find((account) => account.id === editing?.id) ?? editing;
  return (
    <SettingsSection title={t("providerAccounts.title")} testID="provider-accounts-settings">
      <View style={styles.actions}>
        <Button
          variant="outline"
          size="sm"
          onPress={addClaude}
          disabled={pending || !accounts.connected}
          testID="account-add-claude"
        >
          {t("providerAccounts.add", { provider: "Claude" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={addCodex}
          disabled={pending || !accounts.connected}
          testID="account-add-codex"
        >
          {t("providerAccounts.add", { provider: "Codex" })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={refresh}
          disabled={!accounts.connected || accounts.isFetching}
        >
          {t("providerAccounts.refresh")}
        </Button>
      </View>
      {!accounts.connected ? (
        <Text style={styles.error}>{t("common.errors.daemonClientDisconnected")}</Text>
      ) : null}
      {accounts.isPending ? <Text style={styles.text}>{t("common.loading")}</Text> : null}
      {error || accounts.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error ?? t("providerAccounts.loadError")}
        </Text>
      ) : null}
      {accounts.data?.accounts.map((account) => (
        <AccountRow key={account.id} account={account} serverId={serverId} edit={setEditing} />
      ))}
      <SelectField
        label={t("providerAccounts.unknownUsage")}
        value={accounts.data?.policy?.unknownQuota ?? ""}
        selectedDisplay={
          policyOptions.find((option) => option.value === accounts.data?.policy?.unknownQuota) ??
          null
        }
        options={policyOptions}
        onChange={changePolicy}
        placeholder={t("providerAccounts.choosePolicy")}
        emptyText={t("common.empty.noResults")}
        disabled={pending || !accounts.connected}
        size={size}
      />
      {liveEditing ? (
        <AccountEditor
          key={liveEditing.id}
          serverId={serverId}
          account={liveEditing}
          manage={accounts.manage}
          refresh={accounts.refresh}
          connected={accounts.connected}
          onClose={close}
        />
      ) : null}
    </SettingsSection>
  );
}

function AccountRow({
  account,
  serverId,
  edit,
}: {
  account: ProviderAccount;
  serverId: string;
  edit?: (account: ProviderAccount) => void;
}) {
  const { t } = useTranslation();
  const { data } = useProviderAccounts(serverId);
  const open = useCallback(() => edit?.(account), [account, edit]);
  const usageEntry = data?.usage.find((entry) => entry.accountId === account.id);
  const usage = usageEntry?.usage;
  const next = data?.next.find((entry) => entry.accountId === account.id);
  return (
    <View style={[settingsStyles.card, styles.card]} testID={`account-row-${account.id}`}>
      <View style={styles.actions}>
        <Text style={styles.title}>{account.label}</Text>
        {edit ? (
          <Button variant="ghost" size="sm" onPress={open}>
            {t("providerAccounts.manage")}
          </Button>
        ) : null}
      </View>
      <Text style={styles.text}>
        {account.provider === "claude" ? "Claude" : "Codex"} ·{" "}
        {account.identity?.email ? `${account.identity.email} · ` : ""}
        {account.enabled
          ? t(`providerAccounts.auth.${account.authState}`)
          : t("providerAccounts.disabled")}
      </Text>
      {account.removedAt ? <Text style={styles.text}>{t("providerAccounts.removed")}</Text> : null}
      {account.error ? <Text style={styles.error}>{account.error}</Text> : null}
      {next ? (
        <Text style={styles.text}>
          {t("providerAccounts.next", { account: account.label })} · {next.reason}
        </Text>
      ) : null}
      {usageEntry?.stale ? <Text style={styles.text}>{t("providerAccounts.stale")}</Text> : null}
      {usage ? <ProviderUsageCard usage={usage} compact showIdentity={false} /> : null}
    </View>
  );
}

function AccountEditor({
  serverId: _serverId,
  account,
  manage,
  refresh,
  connected,
  onClose,
}: {
  serverId: string;
  account: ProviderAccount;
  manage: Manage;
  refresh: () => Promise<void>;
  connected: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [form] = useState(() => openAccountForm(account));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const codeInput = useRef<EditingTextInputHandle>(null);
  const activeLogin = useRef(state.login);
  activeLogin.current = state.login;
  useEffect(() => {
    form.activate();
    return () => {
      form.close();
    };
  }, [form]);
  useEffect(
    () => () => {
      const login = activeLogin.current;
      if (login)
        void manage({ kind: "login-cancel", accountId: account.id, loginId: login.id }).catch(
          () => undefined,
        );
    },
    [account.id, manage],
  );
  const loginId = state.login?.id;
  useEffect(() => {
    if (!loginId || !connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await manage({ kind: "login-status", accountId: account.id, loginId });
        if (stopped) return;
        form.receiveLogin(result.login);
        if (!result.login) await refresh();
      } catch {
        /* Keep the challenge visible across a transient disconnect. */
      }
      if (!stopped)
        timer = setTimeout(() => {
          void poll();
        }, 2_000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [account.id, connected, form, manage, refresh, loginId]);
  const operate = useCallback(
    (operation: AccountOperation) =>
      form.run(async () => {
        const result = await manage(operation);
        form.receiveLogin(result.login);
        codeInput.current?.replaceText("");
        return result;
      }),
    [form, manage],
  );
  const startLogin = useCallback(() => {
    void operate({ kind: "login-start", accountId: account.id });
  }, [account.id, operate]);
  const inspect = useCallback(() => {
    void operate({ kind: "inspect", accountId: account.id });
  }, [account.id, operate]);
  const logout = useCallback(() => {
    void operate({ kind: "logout", accountId: account.id });
  }, [account.id, operate]);
  const toggle = useCallback(() => {
    void operate({ kind: "edit", accountId: account.id, changes: { enabled: !account.enabled } });
  }, [account.id, account.enabled, operate]);
  const save = useCallback(() => {
    const operation = form.saveOperation();
    if (operation) void operate(operation);
  }, [form, operate]);
  const cancelLogin = useCallback(() => {
    const login = activeLogin.current;
    if (login) void operate({ kind: "login-cancel", accountId: account.id, loginId: login.id });
  }, [account.id, operate]);
  const close = useCallback(async () => {
    if (state.pending) return;
    const login = activeLogin.current;
    if (login) {
      const result = await operate({
        kind: "login-cancel",
        accountId: account.id,
        loginId: login.id,
      });
      if (!result) return;
    }
    onClose();
  }, [account.id, onClose, operate, state.pending]);
  const submitCode = useCallback(() => {
    const login = activeLogin.current;
    if (login)
      void operate({
        kind: "login-code",
        accountId: account.id,
        loginId: login.id,
        code: state.code,
      });
  }, [account.id, operate, state.code]);
  const challenge = state.login?.challenge;
  const openLogin = useCallback(() => {
    if (challenge && challenge.kind !== "starting")
      void form.run(() => Linking.openURL(challenge.url));
  }, [challenge, form]);
  const header = useMemo(() => ({ title: t("providerAccounts.manage") }), [t]);
  const footer = useMemo(
    () => (
      <Button onPress={save} disabled={state.pending || !connected}>
        {t("providerAccounts.save")}
      </Button>
    ),
    [save, state.pending, connected, t],
  );
  const disabled = state.pending || !connected;
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      footer={footer}
      desktopMaxWidth={520}
      testID="account-editor"
    >
      <View style={styles.form}>
        <Field label={t("providerAccounts.label")}>
          <FormTextInput
            initialValue={state.label}
            onChangeText={form.setLabel}
            maxLength={120}
            editable={!disabled}
            size={size}
            testID="account-label"
          />
        </Field>
        <AccountStatus account={account} error={state.error} />
        <View style={styles.actions}>
          <Button variant="outline" size="sm" onPress={inspect} disabled={disabled}>
            {t("providerAccounts.checkLogin")}
          </Button>
          {account.ownership === "managed" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onPress={startLogin}
                disabled={disabled || Boolean(state.login)}
                testID="account-login"
              >
                {t("providerAccounts.signIn")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={logout}
                disabled={disabled || Boolean(state.login)}
              >
                {t("providerAccounts.signOut")}
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="sm" onPress={toggle} disabled={disabled}>
            {account.enabled ? t("providerAccounts.disable") : t("providerAccounts.enable")}
          </Button>
        </View>
        {challenge ? (
          <View style={styles.form} testID="account-login-challenge">
            {challenge.kind === "starting" ? (
              <Text style={styles.text}>{t("common.states.starting")}</Text>
            ) : (
              <>
                <Button onPress={openLogin} disabled={disabled}>
                  {t("providerAccounts.openLogin")}
                </Button>
                {challenge.kind === "device" ? (
                  <Text style={styles.title} selectable>
                    {challenge.userCode}
                  </Text>
                ) : null}
                {challenge.kind === "browser" && challenge.acceptsCode ? (
                  <>
                    <Field label={t("providerAccounts.loginCode")}>
                      <FormTextInput
                        ref={codeInput}
                        initialValue=""
                        onChangeText={form.setCode}
                        autoCorrect={false}
                        autoCapitalize="none"
                        secureTextEntry
                        editable={!disabled}
                        size={size}
                        testID="account-login-code"
                      />
                    </Field>
                    <Button onPress={submitCode} disabled={disabled || !state.code.trim()}>
                      {t("providerAccounts.submitCode")}
                    </Button>
                  </>
                ) : null}
              </>
            )}
            <Button variant="ghost" onPress={cancelLogin} disabled={disabled}>
              {t("common.actions.cancel")}
            </Button>
          </View>
        ) : null}
        {account.ownership === "managed" ? (
          <AccountRemoval
            account={account}
            operate={operate}
            disabled={disabled || Boolean(state.login)}
          />
        ) : null}
        <Field label={t("providerAccounts.reserve")}>
          <FormTextInput
            initialValue={state.reserve}
            onChangeText={form.setReserve}
            keyboardType="decimal-pad"
            editable={!disabled}
            size={size}
            testID="account-reserve"
          />
        </Field>
        <View style={styles.actions}>
          <Text style={styles.text}>{t("providerAccounts.interactiveOnly")}</Text>
          <Switch
            value={state.interactiveOnly}
            onValueChange={form.setInteractiveOnly}
            disabled={disabled}
            accessibilityLabel={t("providerAccounts.interactiveOnly")}
          />
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function AccountStatus({ account, error }: { account: ProviderAccount; error: string | null }) {
  const { t } = useTranslation();
  const message = error ?? account.error;
  return (
    <>
      <Text style={styles.text}>
        {account.identity?.email ?? t(`providerAccounts.auth.${account.authState}`)}
      </Text>
      {message ? (
        <Text style={styles.error} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}
    </>
  );
}

export function ProviderAccountsUsageSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const accounts = useProviderAccounts(serverId);
  if (!accounts.supported) return null;
  return (
    <SettingsSection title={t("providerAccounts.title")} testID="provider-account-usage">
      {accounts.isPending ? <Text style={styles.text}>{t("common.loading")}</Text> : null}
      {accounts.isError ? (
        <Text style={styles.error}>{t("providerAccounts.loadError")}</Text>
      ) : null}
      {(accounts.data?.accounts ?? [])
        .filter((account) => !account.removedAt)
        .map((account) => (
          <AccountRow key={account.id} account={account} serverId={serverId} />
        ))}
    </SettingsSection>
  );
}

function AccountRemoval({
  account,
  operate,
  disabled,
}: {
  account: ProviderAccount;
  operate: (operation: AccountOperation) => Promise<unknown>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState("");
  const options = useMemo(
    () => [
      { id: "retain", value: "retain", label: t("providerAccounts.retainCredentials") },
      { id: "logout", value: "logout", label: t("providerAccounts.logoutCredentials") },
    ],
    [t],
  );
  const remove = useCallback(() => {
    if (credentials === "retain" || credentials === "logout")
      void operate({ kind: "remove", accountId: account.id, credentials });
  }, [account.id, credentials, operate]);
  const restore = useCallback(() => {
    void operate({ kind: "restore", accountId: account.id });
  }, [account.id, operate]);
  if (account.removedAt)
    return (
      <Button variant="outline" onPress={restore} disabled={disabled}>
        {t("providerAccounts.restore")}
      </Button>
    );
  return (
    <View style={styles.form}>
      <Text style={styles.text}>{t("providerAccounts.removalHelp")}</Text>
      <SelectField
        label={t("providerAccounts.remove")}
        value={credentials}
        selectedDisplay={options.find((option) => option.value === credentials) ?? null}
        options={options}
        onChange={setCredentials}
        placeholder={t("providerAccounts.chooseRemoval")}
        emptyText={t("common.empty.noResults")}
        disabled={disabled}
      />
      <Button variant="outline" onPress={remove} disabled={disabled || !credentials}>
        {t("providerAccounts.remove")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], alignItems: "center" },
  form: { gap: theme.spacing[4] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
