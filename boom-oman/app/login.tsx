import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { router } from "expo-router";
import { useApp } from "@/state/AppContext";
import { colors } from "@/theme/colors";

export default function LoginScreen() {
  const { login } = useApp();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);

  const phoneValid = /^9\d{7}$/.test(phone);
  const otpValid = otp.length === 4;

  const sendOtp = () => {
    if (!phoneValid) return;
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setStep("otp");
    }, 700);
  };

  const verifyOtp = async () => {
    if (!otpValid) return;
    setLoading(true);
    setTimeout(async () => {
      await login(`+968${phone}`);
      setLoading(false);
      router.replace("/home");
    }, 700);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <View style={styles.logoMark}>
          <Text style={styles.logoText}>B</Text>
        </View>
        <Text style={styles.title}>Boom عُمان</Text>
        <Text style={styles.subtitle}>توصيل أذكى، أسرع، وبسعرك</Text>
      </View>

      {step === "phone" ? (
        <View style={styles.form}>
          <Text style={styles.label}>رقم الهاتف</Text>
          <View style={styles.phoneRow}>
            <Text style={styles.prefix}>+968</Text>
            <TextInput
              style={styles.input}
              placeholder="9XXXXXXX"
              keyboardType="number-pad"
              maxLength={8}
              value={phone}
              onChangeText={setPhone}
              textAlign="right"
            />
          </View>
          <TouchableOpacity
            style={[styles.button, !phoneValid && styles.buttonDisabled]}
            disabled={!phoneValid || loading}
            onPress={sendOtp}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>إرسال رمز التحقق</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.form}>
          <Text style={styles.label}>أدخل رمز التحقق المرسل إلى +968{phone}</Text>
          <TextInput
            style={[styles.input, styles.otpInput]}
            placeholder="0000"
            keyboardType="number-pad"
            maxLength={4}
            value={otp}
            onChangeText={setOtp}
            textAlign="center"
          />
          <TouchableOpacity
            style={[styles.button, !otpValid && styles.buttonDisabled]}
            disabled={!otpValid || loading}
            onPress={verifyOtp}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>تأكيد الدخول</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep("phone")}>
            <Text style={styles.linkText}>تغيير رقم الهاتف</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  header: { alignItems: "center", marginBottom: 40 },
  logoMark: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  logoText: { color: "#fff", fontSize: 32, fontWeight: "800" },
  title: { fontSize: 26, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 14, color: colors.textMuted, marginTop: 6 },
  form: { gap: 14 },
  label: { fontSize: 14, color: colors.textMuted, textAlign: "right" },
  phoneRow: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  prefix: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    paddingHorizontal: 8,
  },
  input: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 18,
    color: colors.text,
  },
  otpInput: { letterSpacing: 12, fontSize: 24, fontWeight: "700" },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  linkText: {
    textAlign: "center",
    color: colors.primary,
    fontSize: 14,
    marginTop: 4,
  },
});
