import { } from "obsidian";

declare module 'obsidian' {
    interface MenuItem {
        setSubmenu: () => Menu;
        dom: HTMLElement;
    }

    interface Menu {
        currentSubmenu: Menu | undefined;
        items: MenuItem[];
        openSubmenu: (item: MenuItem) => void;
    }
}