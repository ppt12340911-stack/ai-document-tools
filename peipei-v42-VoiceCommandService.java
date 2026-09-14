package com.example.voicephonecontroller;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.ToneGenerator;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.Random;

public class VoiceCommandService extends Service implements RecognitionListener {
    public static final String ACTION_BOOT_RESUME = "com.example.voicephonecontroller.BOOT_RESUME";
    public static final String ACTION_REFRESH_MODE = "com.example.voicephonecontroller.REFRESH_MODE";
    public static final String ACTION_STATE_CHANGED = "com.example.voicephonecontroller.STATE_CHANGED";

    private static final String CHANNEL_ID = "voice_control_channel_v4";
    private static final int NOTIFICATION_ID = 7722;
    private static final long SESSION_WINDOW_MS = 30_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private Intent recognizerIntent;
    private boolean stopping = false;
    private boolean listening = false;
    private boolean usingOnDevice = false;
    private boolean triedSystemFallback = false;
    private long sessionUntil = 0L;
    private ToneGenerator tone;
    private TextToSpeech tts;
    private MediaPlayer startupPlayer;
    private final Random random = new Random();
    private boolean firstStartHandled = false;

    private static final String[] WAKE_REPLIES = {
            "我在", "您好", "請說", "在的", "我來了", "請吩咐", "有什麼需要我幫忙嗎"
    };

    private final Runnable restartRunnable = this::startListeningIfAllowed;

    private final BroadcastReceiver powerReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String a = intent == null ? "" : intent.getAction();
            if (Intent.ACTION_SCREEN_OFF.equals(a) || Intent.ACTION_SCREEN_ON.equals(a) ||
                    Intent.ACTION_USER_PRESENT.equals(a) || Intent.ACTION_POWER_CONNECTED.equals(a) ||
                    Intent.ACTION_POWER_DISCONNECTED.equals(a)) {
                applyPowerPolicy();
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification("V4.2 啟動中…"));
        tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 55);
        tts = new TextToSpeech(getApplicationContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                try { tts.setLanguage(Locale.TAIWAN); } catch (Exception ignored) {}
                try { tts.setSpeechRate(1.06f); } catch (Exception ignored) {}
                try { tts.setPitch(1.14f); } catch (Exception ignored) {}
                try { selectPreferredChineseVoice(); } catch (Exception ignored) {}
            }
        });

        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        registerReceiver(powerReceiver, filter);

        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            updateNotification("此手機沒有可用的語音辨識服務");
            stopSelf();
            return;
        }
        createRecognizer(true);
        createRecognizerIntent();
    }

    private void createRecognizer(boolean preferOnDevice) {
        destroyRecognizer();
        usingOnDevice = false;
        if (preferOnDevice && Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            try {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
                usingOnDevice = true;
            } catch (Exception ignored) {}
        }
        if (recognizer == null) recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(this);
    }

    private void createRecognizerIntent() {
        recognizerIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-TW");
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-TW");
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopping = false;
        VoicePreferences.setServiceEnabledByUser(this, true);
        if (intent != null && ACTION_REFRESH_MODE.equals(intent.getAction())) {
            applyPowerPolicy();
        } else {
            if (!firstStartHandled) {
                firstStartHandled = true;
                playStartupGreeting();
                scheduleListen(2600);
            } else {
                scheduleListen(180);
            }
        }
        broadcastState();
        return START_STICKY;
    }

    private void scheduleListen(long delayMs) {
        handler.removeCallbacks(restartRunnable);
        handler.postDelayed(restartRunnable, delayMs);
    }

    private void startListeningIfAllowed() {
        if (stopping || recognizer == null) return;
        if (!shouldListenNow()) {
            pauseForPowerSaving();
            return;
        }
        if (listening) return;
        try {
            updateNotification(statusText());
            recognizer.startListening(recognizerIntent);
        } catch (Exception e) {
            listening = false;
            updateNotification("語音辨識重新連線中…");
            scheduleListen(1200);
        }
    }

    private void applyPowerPolicy() {
        if (stopping) return;
        if (shouldListenNow()) {
            scheduleListen(120);
        } else {
            pauseForPowerSaving();
        }
        broadcastState();
    }

    private void pauseForPowerSaving() {
        handler.removeCallbacks(restartRunnable);
        if (recognizer != null && listening) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
        }
        listening = false;
        sessionUntil = 0L;
        String mode = VoicePreferences.getListenMode(this);
        String text = VoicePreferences.MODE_ECO.equals(mode)
                ? "省電待命：螢幕關閉，亮屏後自動恢復"
                : "平衡省電：熄屏且未充電，暫停麥克風";
        updateNotification(text);
    }

    private boolean shouldListenNow() {
        String mode = VoicePreferences.getListenMode(this);
        if (VoicePreferences.MODE_ALWAYS.equals(mode)) return true;
        PowerManager pm = getSystemService(PowerManager.class);
        boolean interactive = pm == null || pm.isInteractive();
        if (VoicePreferences.MODE_ECO.equals(mode)) return interactive;
        return interactive || isCharging();
    }

    private boolean isCharging() {
        Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery == null) return false;
        int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;
    }

    private String statusText() {
        String engine = usingOnDevice ? "本機辨識" : "系統辨識";
        if (isSessionActive()) return "已喚醒（" + engine + "），直接說下一個指令…";
        return "等待「沛沛同學」（" + engine + "）…";
    }

    @Override
    public void onResults(Bundle results) {
        listening = false;
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) { scheduleListen(350); return; }

        String heard = matches.get(0);
        CommandMatch match = extractCommand(matches);
        if (match == null) {
            updateNotification(statusText());
            scheduleListen(300);
            return;
        }

        if (match.wakeDetected) {
            sessionUntil = System.currentTimeMillis() + SESSION_WINDOW_MS;
            beepWake();
        }

        String command = match.command == null ? "" : match.command.trim();
        if (command.isBlank()) {
            sessionUntil = System.currentTimeMillis() + SESSION_WINDOW_MS;
            String reply = randomWakeReply();
            speakText(reply);
            updateNotification("沛沛同學：" + reply + "｜30 秒內可直接說指令");
            scheduleListen(1400);
            return;
        }

        String n = VoiceCommandExecutor.normalize(command);
        if (n.equals("休息") || n.equals("結束對話") || n.equals("結束連續模式") || n.equals("取消喚醒")) {
            sessionUntil = 0L;
            updateNotification("已結束連續模式，等待「沛沛同學」…");
            scheduleListen(300);
            return;
        }

        sessionUntil = System.currentTimeMillis() + SESSION_WINDOW_MS;
        String result = VoiceCommandExecutor.execute(this, command);
        String time = new SimpleDateFormat("HH:mm:ss", Locale.TAIWAN).format(new Date());
        VoicePreferences.appendHistory(this, time + "｜" + heard + " → " + result);
        sendBroadcast(new Intent("com.example.voicephonecontroller.HISTORY_UPDATED").setPackage(getPackageName()));
        updateNotification("「" + heard + "」｜" + result + "｜可繼續說指令");
        if (!result.equals("已停止語音控制")) scheduleListen(350);
    }

    private CommandMatch extractCommand(ArrayList<String> matches) {
        for (String text : matches) {
            String normalized = VoiceCommandExecutor.normalize(text);
            int index = indexOfWakeWord(normalized);
            if (index >= 0) {
                String command = normalized.substring(index + wakeWordLength(normalized, index));
                return new CommandMatch(command, true);
            }
        }
        if (isSessionActive()) return new CommandMatch(matches.get(0), false);
        return null;
    }

    private static final String[] WAKE_ALIASES = {
            "沛沛同學", "佩佩同學", "配配同學", "霈霈同學", "珮珮同學"
    };

    private int indexOfWakeWord(String normalized) {
        for (String alias : WAKE_ALIASES) {
            int i = normalized.indexOf(alias);
            if (i >= 0) return i;
        }
        return -1;
    }

    private int wakeWordLength(String normalized, int index) {
        String tail = normalized.substring(index);
        for (String alias : WAKE_ALIASES) if (tail.startsWith(alias)) return alias.length();
        return VoicePreferences.WAKE_WORD.length();
    }

    private boolean isSessionActive() { return System.currentTimeMillis() <= sessionUntil; }

    private void beepWake() {
        try { if (tone != null) tone.startTone(ToneGenerator.TONE_PROP_BEEP, 90); } catch (Exception ignored) {}
    }

    private void playStartupGreeting() {
        playStartupAudio();
        handler.postDelayed(() -> speakText("您好，我在"), 350);
        updateNotification("啟動完成：您好，我在");
    }

    private void playStartupAudio() {
        try {
            if (startupPlayer != null) {
                startupPlayer.release();
                startupPlayer = null;
            }
            startupPlayer = MediaPlayer.create(this, R.raw.startup_voice);
            if (startupPlayer != null) {
                startupPlayer.setOnCompletionListener(mp -> {
                    try { mp.release(); } catch (Exception ignored) {}
                    if (mp == startupPlayer) startupPlayer = null;
                });
                startupPlayer.start();
            }
        } catch (Exception ignored) {}
    }

    private void speakText(String text) {
        try {
            if (tts != null && text != null && !text.isBlank()) {
                if (Build.VERSION.SDK_INT >= 21) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "wakeReply");
                else tts.speak(text, TextToSpeech.QUEUE_FLUSH, null);
            }
        } catch (Exception ignored) {}
    }

    private void selectPreferredChineseVoice() {
        if (tts == null || Build.VERSION.SDK_INT < 21) return;
        android.speech.tts.Voice best = null;
        for (android.speech.tts.Voice v : tts.getVoices()) {
            if (v == null || v.getLocale() == null) continue;
            String lang = v.getLocale().getLanguage();
            String country = v.getLocale().getCountry();
            if (!"zh".equalsIgnoreCase(lang)) continue;
            String name = v.getName() == null ? "" : v.getName().toLowerCase(Locale.ROOT);
            int score = 0;
            if ("TW".equalsIgnoreCase(country)) score += 20;
            if (name.contains("female") || name.contains("woman") || name.contains("girl")) score += 10;
            if (!v.isNetworkConnectionRequired()) score += 5;
            if (best == null || score > voiceScore(best)) best = v;
        }
        if (best != null) tts.setVoice(best);
    }

    private int voiceScore(android.speech.tts.Voice v) {
        if (v == null || v.getLocale() == null) return -1;
        String name = v.getName() == null ? "" : v.getName().toLowerCase(Locale.ROOT);
        int score = 0;
        if ("TW".equalsIgnoreCase(v.getLocale().getCountry())) score += 20;
        if (name.contains("female") || name.contains("woman") || name.contains("girl")) score += 10;
        if (!v.isNetworkConnectionRequired()) score += 5;
        return score;
    }

    private String randomWakeReply() {
        return WAKE_REPLIES[random.nextInt(WAKE_REPLIES.length)];
    }

    @Override
    public void onError(int error) {
        listening = false;
        if (stopping) return;

        if (usingOnDevice && !triedSystemFallback && Build.VERSION.SDK_INT >= 31 &&
                (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)) {
            triedSystemFallback = true;
            createRecognizer(false);
            updateNotification("本機中文模型不可用，已切換系統辨識…");
            scheduleListen(400);
            return;
        }

        if (!shouldListenNow()) { pauseForPowerSaving(); return; }
        long retry = (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) ? 1300 : 550;
        updateNotification(statusText());
        scheduleListen(retry);
    }

    @Override public void onReadyForSpeech(Bundle params) { listening = true; updateNotification(statusText()); }
    @Override public void onBeginningOfSpeech() { updateNotification("正在辨識…"); }
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() { updateNotification("處理語音中…"); }
    @Override public void onPartialResults(Bundle partialResults) {}
    @Override public void onEvent(int eventType, Bundle params) {}

    private Notification buildNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("沛沛同學 語音手機控制 V4.2")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text));
        broadcastState();
    }

    private void broadcastState() {
        Intent i = new Intent(ACTION_STATE_CHANGED).setPackage(getPackageName());
        i.putExtra("on_device", usingOnDevice);
        i.putExtra("listening_allowed", shouldListenNow());
        i.putExtra("mode", VoicePreferences.getListenMode(this));
        sendBroadcast(i);
    }

    private void createNotificationChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    "沛沛同學 語音控制 V4.2", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("顯示沛沛同學 V4.2 的待命、辨識、問候語與省電狀態");
            nm.createNotificationChannel(channel);
        }
    }

    private void destroyRecognizer() {
        listening = false;
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
            try { recognizer.destroy(); } catch (Exception ignored) {}
            recognizer = null;
        }
    }

    @Override
    public void onDestroy() {
        stopping = true;
        handler.removeCallbacks(restartRunnable);
        try { unregisterReceiver(powerReceiver); } catch (Exception ignored) {}
        destroyRecognizer();
        if (tone != null) { try { tone.release(); } catch (Exception ignored) {} tone = null; }
        if (startupPlayer != null) { try { startupPlayer.release(); } catch (Exception ignored) {} startupPlayer = null; }
        if (tts != null) { try { tts.stop(); } catch (Exception ignored) {} try { tts.shutdown(); } catch (Exception ignored) {} tts = null; }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static final class CommandMatch {
        final String command;
        final boolean wakeDetected;
        CommandMatch(String command, boolean wakeDetected) { this.command = command; this.wakeDetected = wakeDetected; }
    }
}
