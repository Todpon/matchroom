<script setup lang="ts">
import { ref, computed, onUnmounted, watch, onMounted } from "vue";
import { auth, db } from "./firebase";
import {
  signInAnonymously,
  onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import {
  doc,
  collection,
  setDoc,
  addDoc,
  onSnapshot,
  runTransaction,
  getDocs,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { ElMessage } from "element-plus";
import { makePairs } from "./utils/pairing";
import { VideoPlay,Refresh } from "@element-plus/icons-vue";

const meName = ref("");
const joinName = ref("");
const joinRoomId = ref("");

const roomId = ref<string>("");
const room = ref<any>(null);
const members = ref<any[]>([]);
const pairs = ref<any[]>([]);

const isHost = computed(() => room.value?.hostUid === auth.currentUser?.uid);
const meUid = computed(() => auth.currentUser?.uid || "");

const nameByUid = computed<Record<string, string>>(() =>
  Object.fromEntries(members.value.map((m) => [m.id, m.displayName || m.id]))
);

const isMobile = ref(false);
onMounted(() => {
  isMobile.value = window.matchMedia("(max-width: 768px)").matches;
});

const myPair = computed(() => {
  const uid = meUid.value;
  if (!uid) return null;
  const p = pairs.value.find((p) => (p.members as string[]).includes(uid));
  if (!p) return null;
  return { index: p.index, members: p.members as string[] };
});

const showMyPairDialog = ref(false);
watch(
  () => pairs.value.map((p) => p.id).join(","),
  () => {
    if (room.value?.status === "paired" && myPair.value) {
      showMyPairDialog.value = true;
    }
  }
);

// -------- auth --------
onAuthStateChanged(auth, async (user) => {
  if (!user) await signInAnonymously(auth);
});

async function ensureLogin(displayName: string) {
  if (!auth.currentUser) await signInAnonymously(auth);
  if (auth.currentUser && !auth.currentUser.displayName) {
    try {
      await updateProfile(auth.currentUser, { displayName });
    } catch {}
  }
}

// -------- room flow --------
async function createRoom() {
  try {
    if (!meName.value.trim()) return ElMessage.error("กรุณาใส่ชื่อ");
    await ensureLogin(meName.value);

    const roomRef = await addDoc(collection(db, "rooms"), {
      name: `ห้องของ ${meName.value}`,
      hostUid: auth.currentUser!.uid,
      status: "open",
      createdAt: serverTimestamp(),
    });

    await setDoc(
      doc(db, "rooms", roomRef.id, "members", auth.currentUser!.uid),
      {
        displayName: meName.value,
        joinedAt: serverTimestamp(),
        isHost: true,
        active: true,
      }
    );

    await enterRoom(roomRef.id);
    ElMessage.success("สร้างห้องสำเร็จ!");
  } catch (e: any) {
    console.error(e);
    ElMessage.error(e?.message || "สร้างห้องไม่สำเร็จ");
  }
}

async function joinRoom() {
  try {
    if (!joinName.value.trim() || !joinRoomId.value.trim()) {
      return ElMessage.error("กรุณาใส่ชื่อและรหัสห้อง");
    }
    await ensureLogin(joinName.value);

    await setDoc(
      doc(db, "rooms", joinRoomId.value, "members", auth.currentUser!.uid),
      {
        displayName: joinName.value,
        joinedAt: serverTimestamp(),
        isHost: false,
        active: true,
      },
      { merge: true }
    );

    await enterRoom(joinRoomId.value);
    ElMessage.success("เข้าร่วมห้องสำเร็จ!");
  } catch (e: any) {
    console.error(e);
    ElMessage.error(e?.message || "เข้าห้องไม่สำเร็จ");
  }
}

let unsubRoom: any, unsubMembers: any, unsubPairs: any;
async function enterRoom(id: string) {
  unsubRoom?.();
  unsubMembers?.();
  unsubPairs?.();

  roomId.value = id;
  const roomRef = doc(db, "rooms", id);

  unsubRoom = onSnapshot(
    roomRef,
    (s) => (room.value = { id: s.id, ...s.data() })
  );
  unsubMembers = onSnapshot(collection(roomRef, "members"), (snap) => {
    members.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.displayName?.localeCompare(b.displayName) || 0);
  });
  unsubPairs = onSnapshot(collection(roomRef, "pairs"), (snap) => {
    pairs.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.index - b.index);
  });
}

onUnmounted(() => {
  unsubRoom?.();
  unsubMembers?.();
  unsubPairs?.();
});

// -------- pairing (สวย + ปลอดภัย) --------
async function startPairing() {
  try {
    if (!isHost.value) return ElMessage.error("เฉพาะหัวห้องเท่านั้น");
    if (!roomId.value) return;

    const roomRef = doc(db, "rooms", roomId.value);
    const membersCol = collection(roomRef, "members");
    const pairsCol = collection(roomRef, "pairs");

    const ms = await getDocs(membersCol);
    const uids = ms.docs.map((d) => d.id);
    if (uids.length < 2) return ElMessage.error("ต้องมีอย่างน้อย 2 คน");

    await runTransaction(db, async (trx) => {
      const snap = await trx.get(roomRef);
      if (!snap.exists()) throw new Error("ไม่พบห้อง");
      const data = snap.data() as any;
      if (data.hostUid !== auth.currentUser!.uid)
        throw new Error("เฉพาะหัวห้องเท่านั้น");
      if (data.status !== "open") throw new Error("ห้องไม่ได้อยู่สถานะ open");
      trx.update(roomRef, { status: "locked", startedAt: serverTimestamp() });
    });

    const batch = writeBatch(db);
    const existing = await getDocs(pairsCol);
    existing.forEach((d) => batch.delete(d.ref));

    const result = makePairs(uids, true);
    result.forEach((members, idx) => {
      const ref = doc(pairsCol);
      batch.set(ref, { members, index: idx + 1 });
    });
    batch.update(roomRef, { status: "paired" });
    await batch.commit();

    ElMessage.success("จับคู่สำเร็จ!");
  } catch (e: any) {
    console.error(e);
    ElMessage.error(e?.message || "เริ่มจับคู่ไม่สำเร็จ");
  }
}

async function reshuffle() {
  if (!isHost.value) return;
  const roomRef = doc(db, "rooms", roomId.value);
  await runTransaction(db, async (trx) => {
    const snap = await trx.get(roomRef);
    if (!snap.exists()) throw new Error("ไม่พบห้อง");
    const data = snap.data() as any;
    if (data.hostUid !== auth.currentUser!.uid)
      throw new Error("เฉพาะหัวห้องเท่านั้น");
    trx.update(roomRef, { status: "open" });
  });
  await startPairing();
}

function pairDisplay(p: any) {
  const names = (p.members as string[]).map((u) => nameByUid.value[u] || u);
  return names.join(" • ");
}

async function copyRoomId() {
  try {
    await navigator.clipboard.writeText(roomId.value);
    ElMessage.success("คัดลอกรหัสห้องแล้ว");
  } catch {
    ElMessage.error("คัดลอกไม่สำเร็จ");
  }
}
</script>

<template>
  <div class="container">
    <!-- Header -->
    <el-page-header class="mb-4">
      <template #content>
        <div class="flex-center-between">
          <h1 class="app-title">MatchRoom</h1>

          <div v-if="room" class="room-chip">
            <span>รหัสห้อง:</span>
            <el-tag type="info" effect="plain">{{ roomId }}</el-tag>
            <el-button size="small" @click="copyRoomId">คัดลอก</el-button>
          </div>
        </div>
      </template>
    </el-page-header>

    <el-row v-if="!room" :gutter="isMobile ? 0 : 16">
      <el-col :xs="24" :md="12" class="mb-4">
        <el-card shadow="hover">
          <template #header>
            <div class="card-head">สร้างห้อง</div>
          </template>

          <el-form label-position="top">
            <el-form-item label="ชื่อของคุณ">
              <el-input v-model="meName" placeholder="เช่น Alex" />
            </el-form-item>
            <el-button type="success" round class="w-100" @click="createRoom">
              เริ่มเลย
            </el-button>
          </el-form>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="12" class="mb-4">
        <el-card shadow="hover">
          <template #header>
            <div class="card-head">เข้าร่วมห้อง</div>
          </template>

          <el-form label-position="top">
            <el-form-item label="ชื่อของคุณ">
              <el-input v-model="joinName" placeholder="เช่น Beam" />
            </el-form-item>
            <el-form-item label="รหัสห้อง">
              <el-input v-model="joinRoomId" placeholder="เช่น a1B2c3" />
            </el-form-item>
            <el-button type="primary" round class="w-100" @click="joinRoom">
              เข้าร่วม
            </el-button>
          </el-form>
        </el-card>
      </el-col>
    </el-row>

    <div v-else class="no-overflow">
      <el-card class="mb-4" shadow="hover">
        <div class="flex-center-between">
          <div class="status-line">
            <span>สถานะ:</span>
            <el-tag
              :type="
                room.status === 'paired'
                  ? 'success'
                  : room.status === 'locked'
                  ? 'warning'
                  : 'info'
              "
            >
              {{ room.status }}
            </el-tag>
          </div>
          <div v-if="isHost" class="btns desktop-only">
            <el-button
              type="primary"
              round
              :disabled="members.length < 2 || room.status !== 'open'"
              @click="startPairing"
              >เริ่มจับคู่</el-button
            >
            <el-button
              type="success"
              round
              :disabled="members.length < 2 || room.status !== 'paired'"
              @click="reshuffle"
              >สุ่มใหม่</el-button
            >
          </div>
        </div>
      </el-card>

      <div class="desktop-only">
        <el-row :gutter="16">
          <el-col :span="12" class="mb-4">
            <el-card shadow="hover">
              <template #header
                ><div class="card-head">
                  สมาชิก ({{ members.length }})
                </div></template
              >
              <el-empty v-if="!members.length" description="ยังไม่มีสมาชิก" />
              <el-scrollbar v-else style="max-height: 420px">
                <el-space direction="vertical" :size="10" fill>
                  <el-card
                    v-for="m in members"
                    :key="m.id"
                    class="member-item"
                    shadow="never"
                  >
                    <div class="member">
                      <el-avatar :size="36" class="avatar">{{
                        m.displayName?.[0]?.toUpperCase() || "U"
                      }}</el-avatar>
                      <div class="name">
                        {{ m.displayName }}
                        <el-tag
                          v-if="m.id === meUid"
                          size="small"
                          effect="plain"
                          type="info"
                          class="ml-4"
                          >ฉัน</el-tag
                        >
                      </div>
                      <el-tag v-if="m.isHost" size="small" type="success"
                        >Host</el-tag
                      >
                    </div>
                  </el-card>
                </el-space>
              </el-scrollbar>
            </el-card>
          </el-col>

          <el-col :span="12" class="mb-4">
            <el-card shadow="hover">
              <template #header><div class="card-head">ผลจับคู่</div></template>
              <el-empty v-if="!pairs.length" description="ยังไม่มีผล" />
              <el-space v-else direction="vertical" :size="10" fill>
                <el-card
                  v-for="p in pairs"
                  :key="p.id"
                  class="pair-item"
                  :class="(p.members as string[]).includes(meUid)?'is-mine':''"
                  shadow="never"
                >
                  <div class="pair-row">
                    <el-tag size="small" effect="plain">#{{ p.index }}</el-tag>
                    <div class="pair-text">{{ pairDisplay(p) }}</div>
                    <el-tag
                      v-if="p.members.length === 3"
                      type="warning"
                      size="small"
                      >3 คน</el-tag
                    >
                    <el-tag
                      v-else-if="p.members.length === 1"
                      type="info"
                      size="small"
                      >บาย</el-tag
                    >
                  </div>
                </el-card>
              </el-space>
            </el-card>
          </el-col>
        </el-row>
      </div>

      <div class="mobile-only">
        <el-card shadow="hover" class="mb-3">
          <el-tabs stretch>
            <el-tab-pane :label="`สมาชิก (${members.length})`" name="members">
              <el-empty v-if="!members.length" description="ยังไม่มีสมาชิก" />
              <el-space v-else direction="vertical" :size="8" fill>
                <el-card
                  v-for="m in members"
                  :key="m.id"
                  class="member-item"
                  shadow="never"
                >
                  <div class="member">
                    <el-avatar :size="40" class="avatar">{{
                      m.displayName?.[0]?.toUpperCase() || "U"
                    }}</el-avatar>
                    <div class="name name-lg">
                      {{ m.displayName }}
                      <el-tag
                        v-if="m.id === meUid"
                        size="small"
                        effect="plain"
                        type="info"
                        class="ml-6"
                        >ฉัน</el-tag
                      >
                    </div>
                    <el-tag v-if="m.isHost" size="small" type="success"
                      >Host</el-tag
                    >
                  </div>
                </el-card>
              </el-space>
            </el-tab-pane>

            <el-tab-pane label="ผลจับคู่" name="pairs">
              <el-empty v-if="!pairs.length" description="ยังไม่มีผล" />
              <el-space v-else direction="vertical" :size="8" fill>
                <el-card
                  v-for="p in pairs"
                  :key="p.id"
                  class="pair-item compact"
                  :class="(p.members as string[]).includes(meUid)?'is-mine':''"
                  shadow="never"
                >
                  <div class="pair-row">
                    <el-tag size="small" effect="plain">#{{ p.index }}</el-tag>
                    <div class="pair-text pair-text-lg">
                      {{ pairDisplay(p) }}
                    </div>
                    <el-tag
                      v-if="p.members.length === 3"
                      type="warning"
                      size="small"
                      >3 คน</el-tag
                    >
                    <el-tag
                      v-else-if="p.members.length === 1"
                      type="info"
                      size="small"
                      >บาย</el-tag
                    >
                  </div>
                </el-card>
              </el-space>
            </el-tab-pane>
          </el-tabs>
        </el-card>

        <!-- sticky bottom actions -->
        <div v-if="isHost" class="mobile-actions">
          <el-button
            type="primary"
            round
            class="flex-1"
            :disabled="members.length < 2 || room.status !== 'open'"
            @click="startPairing"
            >เริ่มจับคู่</el-button
          >
          <el-button
            type="success"
            round
            class="flex-1"
            :disabled="members.length < 2 || room.status !== 'paired'"
            @click="reshuffle"
            >สุ่มใหม่</el-button
          >
        </div>

        <!-- FAB (วงกลม) -->
        <el-button
          v-if="isHost"
          class="fab"
          circle
          :type="room.status === 'open' ? 'primary' : 'success'"
          :icon="room.status === 'open' ? VideoPlay : Refresh"
          @click="room.status === 'open' ? startPairing() : reshuffle()"
        />
      </div>
    </div>

    <div class="mobile-actions">
      <el-button
        type="primary"
        round
        :disabled="members.length < 2 || room.status !== 'open'"
        @click="startPairing"
        >เริ่มจับคู่</el-button
      >
      <el-button
        type="success"
        round
        :disabled="members.length < 2 || room.status !== 'paired'"
        @click="reshuffle"
        >สุ่มใหม่</el-button
      >
    </div>

    <el-dialog
      v-model="showMyPairDialog"
      title="ผลจับคู่ของฉัน"
      :width="isMobile ? '92%' : '420px'"
      align-center
      class="my-dialog"
    >
      <el-result
        icon="success"
        title="ได้คู่แล้ว!"
        :sub-title="`ลำดับ #${myPair?.index}`"
      >
        <template #extra>
          <el-card class="my-pair">
            <div class="my-pair-text">
              {{
                myPair
                  ? myPair.members.map((u) => nameByUid[u] || u).join(" • ")
                  : ""
              }}
            </div>
          </el-card>
          <el-button
            class="mt-2"
            type="primary"
            @click="showMyPairDialog = false"
            >ตกลง</el-button
          >
        </template>
      </el-result>
    </el-dialog>
  </div>
</template>

<style scoped>
html,
body,
#app {
  width: 100%;
  max-width: 100vw;
  overflow-x: hidden;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}
.container {
  max-width: 1060px;
  width: 100%;
  margin: 0 auto;
  padding: 12px;
}

.mb-4 {
  margin-bottom: 16px;
}
.app-title {
  font-size: 28px;
  font-weight: 800;
  margin: 0;
  color: #006359;
}
.flex-center-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-head {
  font-weight: 700;
  color: #1f2a37;
}

/* สมาชิก/คู่ */
.member {
  display: flex;
  align-items: center;
  gap: 12px;
}
.member-item,
.pair-item {
  border-radius: 16px;
}
.avatar {
  background: #e6f2ef;
  color: #006359;
  font-weight: 800;
}
.name {
  font-weight: 600;
  color: #1f2937;
}
.pair-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pair-text {
  font-weight: 700;
  color: #111827;
  flex: 1;
  text-align: right;
}
.pair-item.is-mine {
  outline: 2px solid var(--el-color-primary);
  background: #f1fbf8;
}

/* Desktop/Mobile toggle */
.desktop-only {
  display: block;
}
.mobile-only {
  display: none;
}

.pair-text,
.name {
  word-break: break-word;
  overflow-wrap: anywhere;
}
@media (max-width: 768px) {
  .no-overflow :deep(.el-row) {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  .no-overflow :deep(.el-col) {
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
}

@media (max-width: 768px) {
  .app-title {
    font-size: 24px;
  }
  .desktop-only {
    display: none;
  }
  .mobile-only {
    display: block;
  }

  .name-lg {
    font-size: 16px;
  }
  .pair-text-lg {
    font-size: 16px;
    text-align: left;
  }
  .member-item,
  .pair-item.compact {
    padding: 8px 10px;
  }

  .mobile-actions {
    position: sticky;
    bottom: 0;
    z-index: 20;
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    background: #fff;
    border-radius: 16px;
    box-shadow: var(--el-box-shadow-light);
    margin: 10px 0 4px;
  }

  .fab {
    position: fixed;
    right: 16px;
    bottom: 88px;
    z-index: 30;
    width: 56px;
    height: 56px;
    border-radius: 9999px;
    box-shadow: var(--el-box-shadow-light);
  }

  :deep(.my-dialog .el-dialog) {
    width: 92vw !important;
    max-width: 92vw;
    margin: 0 auto;
    border-radius: 16px;
  }
}
.room-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: 100%;
}
.room-chip :deep(.el-tag) {
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fab {
  position: fixed;
  right: 16px;
  bottom: 88px;
  z-index: 30;
  width: 56px;
  height: 56px;
  border-radius: 9999px;
  box-shadow: var(--el-box-shadow-light);
}
@media (max-width: 768px) {
  .mobile-actions .el-button {
    width: 100%;
  }
}
</style>
