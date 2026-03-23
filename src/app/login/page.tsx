"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Navigation, Mail, Lock, LogIn, UserPlus, Tag, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [deviceCodes, setDeviceCodes] = useState<string[]>([""]);
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const addDeviceField = () => setDeviceCodes(prev => [...prev, ""]);
  const removeDeviceField = (idx: number) => setDeviceCodes(prev => prev.filter((_, i) => i !== idx));
  const updateDeviceCode = (idx: number, val: string) => setDeviceCodes(prev => prev.map((v, i) => i === idx ? val : v));

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (isSignUp) {
        const validCodes = deviceCodes.map(d => d.trim()).filter(Boolean);
        if (validCodes.length === 0) {
          setError("Please enter at least one device code.");
          setLoading(false);
          return;
        }

        // 1. Create the account
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;

        if (data.user) {
          // 2. Link ALL device codes to this user
          const rows = validCodes.map(device_id => ({ user_id: data.user!.id, device_id }));
          const { error: deviceError } = await supabase.from("user_devices").insert(rows);
          if (deviceError) console.error("Device link error:", deviceError);
        }

        setError(`✅ Account created! ${validCodes.length} device(s) linked. Check your email to confirm, then sign in.`);
        setIsSignUp(false);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/");
        router.refresh();
      }
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-3 mb-8">
          <Navigation className="text-blue-500 w-10 h-10" />
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
            Fleet Tracker
          </h1>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-8 backdrop-blur-xl shadow-2xl">
          <h2 className="text-xl font-semibold text-white mb-6 text-center">
            {isSignUp ? "Create Account" : "Welcome Back"}
          </h2>

          <form onSubmit={handleAuth} className="flex flex-col gap-4">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required
                className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all placeholder:text-slate-500" />
            </div>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input type="password" placeholder="Password (min. 6 characters)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all placeholder:text-slate-500" />
            </div>

            {/* Multi-Device Fields — only shown during sign up */}
            {isSignUp && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-cyan-400" /> Tracker Device Codes
                </p>

                {deviceCodes.map((code, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="relative flex-1">
                      <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                      <input
                        type="text"
                        placeholder={`Device ${idx + 1} (e.g. ESP32-Car2)`}
                        value={code}
                        onChange={(e) => updateDeviceCode(idx, e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 transition-all placeholder:text-slate-500"
                      />
                    </div>
                    {deviceCodes.length > 1 && (
                      <button type="button" onClick={() => removeDeviceField(idx)}
                        className="p-3 rounded-xl bg-red-900/40 border border-red-800 text-red-400 hover:bg-red-900/60 transition">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}

                <button type="button" onClick={addDeviceField}
                  className="flex items-center gap-2 text-xs text-cyan-400 hover:text-cyan-300 transition mt-1">
                  <Plus className="w-3.5 h-3.5" /> Add another device
                </button>

                <p className="text-[10px] text-slate-500">
                  Enter device IDs exactly as they appear (case-sensitive). Found in your tracker's serial output.
                </p>
              </div>
            )}

            {error && (
              <div className={`text-sm p-3 rounded-lg ${error.startsWith("✅") ? "bg-emerald-950/40 border border-emerald-800 text-emerald-400" : "bg-red-950/40 border border-red-800 text-red-400"}`}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30">
              {loading ? "Please wait..." : isSignUp ? (
                <><UserPlus className="w-4 h-4" /> Create Account</>
              ) : (
                <><LogIn className="w-4 h-4" /> Sign In</>
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button onClick={() => { setIsSignUp(!isSignUp); setError(""); setDeviceCodes([""]); }}
              className="text-sm text-blue-400 hover:text-blue-300 transition">
              {isSignUp ? "Already have an account? Sign In" : "Don't have an account? Sign Up"}
            </button>
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          Fleet Tracker &copy; {new Date().getFullYear()}
        </p>
      </div>
    </main>
  );
}
