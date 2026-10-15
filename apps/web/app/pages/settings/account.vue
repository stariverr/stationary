<script setup lang="ts">
import { storeToRefs } from "pinia";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useUserStore } from "@/stores/user";

const { $auth } = useNuxtApp();
const session = $auth.useSession();

const { userProfile } = storeToRefs(useUserStore());
const displayName = computed(() => userProfile.value?.name || "User");
const displayImage = computed(() => userProfile.value?.image || "");
const userEmail = computed(() => userProfile.value?.email || "");

const signOut = async () => {
    await $auth.signOut();
    await navigateTo("/login");
};
</script>

<template>
    <Card class="py-0">
        <CardContent class="space-y-6 p-5">
            <div v-if="session.data?.user" class="flex items-center gap-4 rounded-xl border bg-muted/30 p-4">
                <Avatar class="size-16 border-2 border-background shadow-sm">
                    <AvatarImage v-if="displayImage" :src="displayImage" :alt="displayName" />
                    <AvatarFallback class="text-xl font-bold">
                        {{ displayName.charAt(0)?.toUpperCase() || "U" }}
                    </AvatarFallback>
                </Avatar>
                <div class="space-y-1">
                    <h4 class="text-lg font-bold leading-none">{{ displayName }}</h4>
                    <p class="text-sm text-muted-foreground">{{ userEmail }}</p>
                    <Badge variant="secondary" class="uppercase tracking-wider">{{ $t("settings.account.verified") }}</Badge>
                </div>
            </div>
            <div v-else class="py-10 text-center text-muted-foreground">
                {{ $t("settings.account.not_signed_in") }}
            </div>

            <div class="grid gap-2">
                <Label>{{ $t("settings.account.user_id") }}</Label>
                <div class="truncate rounded border bg-muted/40 p-2 font-mono text-xs text-muted-foreground">
                    {{ session.data?.user?.id || "N/A" }}
                </div>
            </div>
            <Button variant="outline" class="w-full text-destructive hover:text-destructive" @click="signOut">
                {{ $t("settings.account.sign_out") }}
            </Button>
        </CardContent>
    </Card>
</template>
