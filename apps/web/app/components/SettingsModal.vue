<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { type AcceptableValue } from 'reka-ui'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useUserSettings } from '@/composables/useUserSettings'
import { authClient, useSession } from '@/lib/auth-client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { computed } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false }
})

const emit = defineEmits(['update:open'])

const isOpen = computed({
  get: () => props.open,
  set: (val) => emit('update:open', val)
})

const { expandDetailByDefault } = useUserSettings()
const { locale, setLocale, locales } = useI18n()
const session = useSession()

const localeOptions = computed(() => {
  return (locales.value).map(l => ({
    code: typeof l === 'string' ? l : l.code,
    name: typeof l === 'string' ? l : (l.name || l.code)
  }));
});

const handleLocaleChange = (value: AcceptableValue) => {
  if (typeof value === 'string') {
    setLocale(value as Parameters<typeof setLocale>[0])
  }
}
</script>

<template>
  <Dialog :open="isOpen" @update:open="isOpen = $event">
    <DialogContent class="sm:max-w-[600px] flex flex-col p-0 overflow-hidden bg-white">
      <DialogHeader class="px-6 py-4 border-b shrink-0">
        <DialogTitle class="text-xl font-bold">Settings</DialogTitle>
        <DialogDescription>
          Manage your account settings and preferences.
        </DialogDescription>
      </DialogHeader>

      <div class="p-6 overflow-y-auto max-h-[80vh]">
        <Tabs default-value="general" class="w-full">
          <TabsList class="grid w-full grid-cols-3 mb-6">
            <TabsTrigger value="general">
              General
            </TabsTrigger>
            <TabsTrigger value="appearance">
              Appearance
            </TabsTrigger>
            <TabsTrigger value="account">
              Account
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general">
            <div class="grid gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>General Settings</CardTitle>
                  <CardDescription>
                    Basic application preferences and display settings.
                  </CardDescription>
                </CardHeader>
                <CardContent class="grid gap-6">
                  <div class="flex items-center justify-between">
                    <div class="space-y-0.5">
                      <Label class="text-base">Expand Detail by Default</Label>
                      <p class="text-sm text-muted-foreground">Automatically expand post details in the feed.</p>
                    </div>
                    <Switch :checked="expandDetailByDefault" @update:checked="expandDetailByDefault = $event" />
                  </div>

                  <div class="grid gap-3">
                    <div class="space-y-0.5">
                      <Label class="text-base">Interface Language</Label>
                      <p class="text-sm text-muted-foreground">Select your preferred language.</p>
                    </div>
                    <Select :model-value="locale" @update:model-value="handleLocaleChange">
                      <SelectTrigger class="w-[200px]">
                        <SelectValue placeholder="Select a language" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem v-for="l in localeOptions" :key="l.code" :value="l.code">
                            {{ l.name }}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Other Preferences</CardTitle>
                  <CardDescription>
                    Additional settings will appear here soon.
                  </CardDescription>
                </CardHeader>
                <CardContent class="py-10 text-center text-sm text-muted-foreground italic">
                  No other settings currently available.
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="appearance">
            <Card>
              <CardHeader>
                <CardTitle>Appearance</CardTitle>
                <CardDescription>
                  Customize the look and feel of the application.
                </CardDescription>
              </CardHeader>
              <CardContent class="py-20 text-center text-gray-400">
                Coming soon.
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="account">
            <Card>
              <CardHeader>
                <CardTitle>Account Profile</CardTitle>
                <CardDescription>
                  Manage your personal account information and profile.
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <div v-if="session.data?.user" class="flex items-center gap-4 p-4 border rounded-xl bg-gray-50/30">
                  <Avatar class="w-16 h-16 border-2 border-white shadow-sm">
                    <AvatarImage v-if="session.data.user?.image" :src="session.data.user?.image" :alt="session.data.user?.name || 'User'" />
                    <AvatarFallback class="bg-blue-100 text-blue-700 text-xl font-bold">
                      {{ session.data.user?.name?.charAt(0)?.toUpperCase() || 'U' }}
                    </AvatarFallback>
                  </Avatar>
                  <div class="space-y-1">
                    <h4 class="text-lg font-bold leading-none">{{ session.data.user?.name || 'User' }}</h4>
                    <p class="text-sm text-muted-foreground">{{ session.data.user?.email || '' }}</p>
                    <div class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 uppercase tracking-wider">
                      Verified Account
                    </div>
                  </div>
                </div>
                <div v-else class="py-10 text-center text-gray-400">
                  Please sign in to view your account details.
                </div>

                <div class="grid gap-4">
                  <div class="grid gap-2">
                    <Label>User ID</Label>
                    <div class="p-2 bg-gray-50 border rounded text-xs font-mono text-gray-500 truncate">
                      {{ session.data?.user?.id || 'N/A' }}
                    </div>
                  </div>
                  <Button variant="outline" class="w-full text-red-600 hover:text-red-700 hover:bg-red-50" @click="authClient.signOut()">
                    Sign Out
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  </Dialog>
</template>

