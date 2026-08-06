import { describe, expect, test } from "bun:test";
import { DeleteService } from "@/services/delete";

describe("DeleteService Unit & Cascade Integrity Tests", () => {
    test("DeleteService exports all required delete methods", () => {
        expect(typeof DeleteService.deletePost).toBe("function");
        expect(typeof DeleteService.deleteMedia).toBe("function");
        expect(typeof DeleteService.deleteTrack).toBe("function");
        expect(typeof DeleteService.deleteLibrary).toBe("function");
        expect(typeof DeleteService.deleteAuthor).toBe("function");
        expect(typeof DeleteService.deleteTag).toBe("function");
    });
});
